// index.js 
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const os = require('os');


// Supabase client
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

// CommonJS-safe fetch
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// Twilio client
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Tracks CallSids for calls that are expected to have a voicemail (so we don't send the no-voicemail intro)
const pendingVoicemails = new Set();

// OpenAI client
const OpenAI = require('openai').default;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
const port = process.env.PORT || 3001;

app.set('trust proxy', 1);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// Serve static assets from public folder
app.use(express.static(path.join(__dirname, 'public')));

// ================= Pages =================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public/login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public/dashboard.html')));
app.get('/success', (req, res) => res.sendFile(path.join(__dirname, 'public/success.html')));

// Admin credentials for testing
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password123';

app.post('/dashboard/view', async (req, res) => {
  const { email, password } = req.body;

  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    // Set a simple session cookie for testing (optional)
    // res.cookie('user', 'admin', { httpOnly: true });
    return res.redirect('/dashboard');
  }

  return res.send('Invalid credentials. <a href="/login">Try again</a>');
});


// Logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Rate limiter
const smsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: 'Too many requests. Please try again later.'
});

// Helpers
function formatPhone(phone) {
  if (!phone) return '';
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) return `+61${cleaned.slice(1)}`;
  if (cleaned.startsWith('61')) return `+${cleaned}`;
  if (phone.startsWith('+')) return phone;
  return `+${cleaned}`;
}

function isValidAUSMobile(phone) {
  return /^\+61[0-9]{9}$/.test(phone);
}

const conversations = {}; // store ongoing conversations

// Improved time parser that handles all common formats
function parseTime(text) {
  if (!text) return null;
  const lower = text.toLowerCase();

  // Match things like "2", "2pm", "2:00", "2:00pm"
  const match = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!match) return null;

  let hour = parseInt(match[1], 10);
  let minutes = match[2] ? parseInt(match[2], 10) : 0;
  const ampm = match[3];

  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  // Default assumption: no am/pm means afternoon
  if (!ampm && hour >= 1 && hour <= 12) {
    if (hour < 8) hour += 12; // assume tradie jobs are afternoon
  }

  // Build a Date object for today
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minutes, 0, 0);

  // If time has already passed today → bump to tomorrow
  if (d < now) {
    d.setDate(d.getDate() + 1);
  }

  return d; // full Date object
}

// GPT-powered name + intent + description extraction
async function parseNameAndIntent(text) {
  try {
    const gptResp = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: `
You are an AI that extracts structured info from a customer SMS.
Return a JSON object with:
- name: if given, otherwise "Customer"
- intent: short phrase (quote, booking, plumbing issue, electrical job, leaking tap, etc.)
- description: concise 1-sentence summary of what they want
          `
        },
        { role: 'user', content: text }
      ],
      temperature: 0
    });

    const raw = gptResp.choices[0].message.content.trim();
    return JSON.parse(raw);
  } catch (err) {
    console.error('❌ parseNameAndIntent failed:', err.message);
    return { name: 'Customer', intent: 'other', description: text };
  }
}

// ================= Onboarding SMS =================
app.post('/send-sms', smsLimiter, async (req, res) => {
  const { name, phone } = req.body;
  if (!phone) return res.status(400).send('Phone number required');
  const formattedPhone = formatPhone(phone);
  if (!isValidAUSMobile(formattedPhone)) return res.status(400).send('Invalid Australian mobile number');

  try {
    const assistantNumber = process.env.TWILIO_PHONE;
    await client.messages.create({ body: `⚡️Hi ${name}, your 24/7 assistant is now active ✅`, from: assistantNumber, to: formattedPhone });
    await client.messages.create({ body: `📲 Please forward your mobile number to ${assistantNumber} so we can handle missed calls.`, from: assistantNumber, to: formattedPhone });
    await client.messages.create({ body: `Tip: Set forwarding to "When Busy" or "When Unanswered". You're all set ⚡️`, from: assistantNumber, to: formattedPhone });

    console.log(`✅ Onboarding SMS sent to ${formattedPhone}`);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ Error in /send-sms:', err.message);
    res.status(500).send('Failed to send SMS');
  }
});

// Register new user
app.post('/register', async (req, res) => {
  const { name, business, email, phoneRaw, planSelect } = req.body;

  if (!name || !business || !email || !phoneRaw || !planSelect) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const phone = formatPhone(phoneRaw);
  if (!isValidAUSMobile(phone)) {
    return res.status(400).json({ error: 'Invalid AU phone number' });
  }

  try {
    // Save to Supabase
    const { data, error } = await supabase
      .from('users')
      .insert([{ name, business, email, phone, plan: planSelect }]);

    if (error) throw error;

    // Onboarding SMS
    await client.messages.create({
      body: `⚡️Hi ${name}, welcome to TradeAssist A.I!`,
      from: process.env.TWILIO_PHONE,
      to: phone
    });

    console.log(`✅ Registered ${name} (${phone})`);
    res.status(200).json({ success: true, user: data[0] });
  } catch (err) {
    console.error('❌ Register failed:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});


// ================= Call-status handler (missed/busy/no voicemail) =================
app.post('/call-status', async (req, res) => {
  const callStatus = req.body.CallStatus;
  const recordingUrl = req.body.RecordingUrl || ''; // Twilio includes this if a voicemail was recorded
  const callSid = req.body.CallSid; // unique per call
  const from = formatPhone(req.body.From || '');
  const tradieNumber = process.env.TRADIE_PHONE_NUMBER;

  if (!from) return res.status(400).send('Missing caller number');

  console.log(`[call-status] CallSid=${callSid} status=${callStatus} recordingUrl=${!!recordingUrl} from=${from}`);

  const convo = conversations[from];

  // If we've already processed a voicemail for this caller and have transcription, skip.
  if (convo && convo.type === 'voicemail' && convo.transcription) {
    console.log(`ℹ️ Skipping follow-up for ${from} because voicemail already handled`);
    return res.status(200).send('Voicemail already handled');
  }

  try {
    // Case 1: Busy / no-answer before voicemail offered — treat as missed call (no voicemail)
    if (['no-answer', 'busy'].includes(callStatus)) {
      const introMsg = `G’day, this is ${process.env.TRADIE_NAME} from ${process.env.TRADES_BUSINESS}. Sorry I missed your call — can I grab your name and whether you’re after a quote, booking, or something else?`;
      await client.messages.create({ body: introMsg, from: process.env.TWILIO_PHONE, to: from });

      conversations[from] = { step: 'awaiting_details', type: 'missed_call_no_voicemail', tradie_notified: false };

      await client.messages.create({
        body: `⚠️ Missed call (no-answer/busy) from ${from}. Assistant sent initial follow-up.`,
        from: process.env.TWILIO_PHONE,
        to: tradieNumber
      });

      await supabase.from('messages').insert([{
        user_id: 'e0a6c24f-8ecf-42fc-b240-7d3e8350e543',
        from_number: from,
        type: 'missed_call_no_voicemail',
        content: '[No message left]',
        created_at: new Date().toISOString()
      }]);

      console.log(`✅ Missed call (no-answer/busy) handled for ${from}`);
    }

    // Case 2a: Call completed AND Twilio tells us there is a recording URL right away → voicemail will be handled in /voicemail
    else if (callStatus === 'completed' && recordingUrl) {
      // Mark this CallSid as a pending voicemail so we skip the 'no voicemail' intro
      if (callSid) {
        pendingVoicemails.add(callSid);
        console.log(`[call-status] Detected recording for CallSid=${callSid}. Marked pendingVoicemails.`);
      }
      // Don't send the normal "no voicemail" intro here — voicemail flow will handle notifications.
    }

    // Case 2b: Call completed AND there is NO recordingUrl (likely a real hangup/no voicemail)
    else if (callStatus === 'completed' && !recordingUrl) {
      // If Twilio previously indicated a voicemail is pending for this callSid, skip sending the no-voicemail intro.
      if (callSid && pendingVoicemails.has(callSid)) {
        console.log(`[call-status] CallSid=${callSid} is pending voicemail; skipping no-voicemail intro.`);
      } else {
        const followUpMsg = `Hi, it’s ${process.env.TRADIE_NAME} from ${process.env.TRADES_BUSINESS}. Looks like I missed your call — can I grab your name and what you’re after (quote, booking, or something else)?`;
        await client.messages.create({ body: followUpMsg, from: process.env.TWILIO_PHONE, to: from });

        conversations[from] = { step: 'awaiting_details', type: 'missed_call_no_voicemail', tradie_notified: false };

        await client.messages.create({
          body: `⚠️ Missed call (no voicemail) from ${from}. Assistant followed up.`,
          from: process.env.TWILIO_PHONE,
          to: tradieNumber
        });

        await supabase.from('messages').insert([{
          user_id: 'e0a6c24f-8ecf-42fc-b240-7d3e8350e543',
          from_number: from,
          type: 'missed_call_no_voicemail',
          content: '[No voicemail]',
          created_at: new Date().toISOString()
        }]);

        console.log(`✅ Missed call (no voicemail) handled for ${from}`);
      }
    }

  } catch (err) {
    console.error('❌ Error handling call-status:', err.message);
  }

  res.status(200).send('Call status processed');
});

// ================= Voice handler =================
app.post('/voice', (req, res) => {
  const response = new twilio.twiml.VoiceResponse();
  response.say("Hi! The tradie is unavailable. Leave a message after the beep.");
  response.record({
    maxLength: 60,
    playBeep: true,
    transcribe: true,
    transcribeCallback: process.env.BASE_URL + '/voicemail'
  });
  response.hangup();
  res.type('text/xml').send(response.toString());
});

// Transcribe helper
async function transcribeRecording(url) {
  if (!url) throw new Error('No recording URL provided');

  const response = await fetch(url, {
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')
    }
  });

  if (!response.ok) throw new Error(`Failed to download audio: ${response.statusText}`);

  const tempFilePath = path.join(os.tmpdir(), `voicemail_${Date.now()}.mp3`);
  const fileStream = fs.createWriteStream(tempFilePath);
  await new Promise((resolve, reject) => {
    response.body.pipe(fileStream);
    response.body.on('error', reject);
    fileStream.on('finish', resolve);
  });

  const transcriptionResponse = await openai.audio.transcriptions.create({
    file: fs.createReadStream(tempFilePath),
    model: 'whisper-1',
  });

  fs.unlink(tempFilePath, () => {});
  return transcriptionResponse.text;
}

// ================= Voicemail callback with AI follow-up =================
app.post('/voicemail', async (req, res) => {
  const recordingUrl = req.body.RecordingUrl ? `${req.body.RecordingUrl}.mp3` : '';
  const from = formatPhone(req.body.From || '');
  const tradieNumber = process.env.TRADIE_PHONE_NUMBER;
  const callSid = req.body.CallSid;

  if (!from) return res.status(400).send('Missing caller number');

  console.log(`[voicemail] CallSid=${callSid} from=${from} recordingUrl=${!!recordingUrl}`);

  // If we previously marked this call as pending voicemail, remove it now so call-status won't attempt an intro later
  if (callSid && pendingVoicemails.has(callSid)) {
    pendingVoicemails.delete(callSid);
    console.log(`[voicemail] Cleared pendingVoicemails for CallSid=${callSid}`);
  }

  let transcription = '[Unavailable]';
  try {
    transcription = await transcribeRecording(recordingUrl);
  } catch (err) {
    console.error('❌ Transcription failed:', err.message);
  }

  // Store conversation state as voicemail
  conversations[from] = { step: 'awaiting_details', transcription, type: 'voicemail' };

  try {
    // Notify tradie via SMS
    await client.messages.create({
      body: `🎙️ Voicemail from ${from}: "${transcription}"`,
      from: process.env.TWILIO_PHONE,
      to: tradieNumber
    });

    await supabase.from('messages').insert([{
      user_id: 'e0a6c24f-8ecf-42fc-b240-7d3e8350e543',
      from_number: from,
      type: 'voicemail',
      transcription,
      created_at: new Date().toISOString()
    }]);

    // Generate AI follow-up SMS
    const gptResp = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: `
You are a concise Aussie tradie assistant.
Send one follow-up SMS asking for customer name and intent (quote/booking/other).
Offer to schedule a call between 1-3pm.
Keep message short and friendly.
        `},
        { role: 'user', content: `Transcription of voicemail: "${transcription}"` }
      ]
    });

    const aiReply = gptResp.choices[0].message.content.trim();
    if (aiReply && isValidAUSMobile(from)) {
      await client.messages.create({ body: aiReply, from: process.env.TWILIO_PHONE, to: from });
    }

    console.log(`✅ Voicemail processed & AI follow-up sent for ${from}`);
    res.status(200).send('Voicemail processed with AI follow-up');
  } catch (err) {
    console.error('❌ Voicemail handling failed:', err.message);
    res.status(500).send('Failed voicemail handling');
  }
});

// ================= SMS webhook =================
app.post('/sms', (req, res) => {
  const from = formatPhone(req.body.From || '');
  const body = (req.body.Body || '').trim();
  const tradieNumber = process.env.TRADIE_PHONE_NUMBER;

  if (!from || !body) return res.status(400).send('Missing SMS data');

  console.log(`📩 Received SMS from ${from}: "${body}"`);

  // Ensure a conversation exists
  let convo = conversations[from] || { step: 'new', tradie_notified: false, type: 'missed_call_no_voicemail' };

  // Respond to Twilio immediately
  res.status(200).send('<Response></Response>');

  // Process the SMS asynchronously
  (async () => {
    try {
      let reply = '';

      if (convo.step === 'awaiting_details') {
        // Extract name and intent
        let info;
        try {
          info = await parseNameAndIntent(body);
        } catch (err) {
          console.error('❌ parseNameAndIntent failed:', err);
          info = { name: 'Customer', intent: 'other', description: body };
        }
        convo.customer_info = info;

        let detailsText = info.description || '';
        if (convo.type === 'voicemail' && convo.transcription) {
          detailsText = `${detailsText} (Voicemail: ${convo.transcription})`;
        }

        // Notify tradie
        await client.messages.create({
          body: `📩 ${convo.type === 'voicemail' ? 'Voicemail received' : 'Missed call from'} ${from}
Name: ${info.name}
Intent: ${info.intent}
Details: ${detailsText}
Waiting for call time...`,
          from: process.env.TWILIO_PHONE,
          to: tradieNumber
        });

        // Insert into Supabase "messages"
        try {
          await supabase.from('messages').insert([{
            user_id: 'e0a6c24f-8ecf-42fc-b240-7d3e8350e543',
            from_number: from,
            type: convo.type,
            content: body,
            customer_name: info.name,
            intent: info.intent,
            details: detailsText,
            created_at: new Date().toISOString()
          }]);
        } catch (err) {
          console.error('❌ Supabase insert failed:', err);
        }

        // Generate reply
        reply = `Thanks ${info.name}! What time works for a call between 1-3 pm?`;
        convo.step = 'scheduling';

      } else if (convo.step === 'scheduling') {
        let proposedTime = parseTime(body);

        if (!proposedTime) {
          try {
            const gptResp = await openai.chat.completions.create({
              model: 'gpt-3.5-turbo',
              messages: [
                { role: 'system', content: 'You are a concise Aussie tradie assistant. Extract a valid call time between 1-3 pm from the customer message.' },
                { role: 'user', content: `Customer said: "${body}"` }
              ]
            });
            proposedTime = gptResp.choices[0].message.content.trim();
          } catch (err) {
            console.error('❌ OpenAI call failed:', err);
          }
        }

        if (proposedTime) {
          reply = `Thanks! Everything is confirmed. We will see you at ${proposedTime}.`;

          // Notify tradie
          await client.messages.create({
            body: `✅ Booking confirmed for ${from}
Name: ${convo.customer_info.name}
Intent: ${convo.customer_info.intent}
Details: ${convo.customer_info.description}
Call at ${proposedTime}`,
            from: process.env.TWILIO_PHONE,
            to: tradieNumber
          });

          // Insert booking into Supabase "bookings" table
          try {
            await supabase.from('bookings').insert([{
              user_id: 'e0a6c24f-8ecf-42fc-b240-7d3e8350e543',
              from_number: from, // <-- add this
              customer_name: convo.customer_info.name,
              intent: convo.customer_info.intent,
              details: convo.customer_info.description,
              proposed_time: proposedTime,
              created_at: new Date().toISOString()
            }]);
          } catch (err) {
            console.error('❌ Supabase booking insert failed:', err);
          }

          convo.step = 'done';
        } else {
          // Ask customer to reschedule via OpenAI
          try {
            const gptResp = await openai.chat.completions.create({
              model: 'gpt-3.5-turbo',
              messages: [
                { role: 'system', content: 'You are a concise Aussie tradie assistant. Suggest rescheduling between 1-3pm if customer time is invalid.' },
                { role: 'user', content: `Customer proposed call time: "${body}".` }
              ]
            });
            reply = gptResp.choices[0].message.content.trim();
          } catch (err) {
            console.error('❌ OpenAI reschedule call failed:', err);
          }
        }
      }

      // Send reply if available
      if (reply) {
        await client.messages.create({ body: reply, from: process.env.TWILIO_PHONE, to: from });
      }

    } catch (err) {
      console.error('❌ SMS async processing failed:', err);
    } finally {
      // Always save the updated conversation state
      conversations[from] = convo;
    }
  })();
});

// ================= Dashboard API Endpoints =================

// ================= API: Fetch all messages =================
app.get('/api/messages', async (req, res) => {
  try {
 const { data, error } = await supabase
  .from('messages')
  .select('*')
  .eq('user_id', 'e0a6c24f-8ecf-42fc-b240-7d3e8350e543')
  .order('created_at', { ascending: false });


    if (error) {
      console.error('❌ Error fetching messages:', error.message);
      return res.status(500).json({ error: 'Failed to fetch messages' });
    }

    res.json(data);
  } catch (err) {
    console.error('❌ /api/messages failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ================= API: Fetch all bookings =================
app.get('/api/bookings', async (req, res) => {
  try {
  const { data, error } = await supabase
  .from('bookings')
  .select('*')
  .eq('user_id', 'e0a6c24f-8ecf-42fc-b240-7d3e8350e543')
  .order('created_at', { ascending: false });


    if (error) {
      console.error('❌ Error fetching bookings:', error.message);
      return res.status(500).json({ error: 'Failed to fetch bookings' });
    }

    res.json(data);
  } catch (err) {
    console.error('❌ /api/bookings failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ================= API: Add booking manually (optional) =================
app.post('/api/bookings', async (req, res) => {
  try {
    const { customer_name, intent, details, proposed_time } = req.body;

   const { data, error } = await supabase
  .from('bookings')
  .insert([{
    user_id: 'e0a6c24f-8ecf-42fc-b240-7d3e8350e543',
    customer_name,
    intent,
    details,
    proposed_time,
    created_at: new Date().toISOString()
  }])
  .select();


    if (error) {
      console.error('❌ Error inserting booking:', error.message);
      return res.status(500).json({ error: 'Failed to insert booking' });
    }

    res.json(data[0]);
  } catch (err) {
    console.error('❌ /api/bookings POST failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ================= Start server =================
const port = process.env.PORT || 3000;   // <- Use Render port
const host = '0.0.0.0';                  // <- 0.0.0.0 is fine
app.listen(port, host, () => {
  console.log(`🚀 Server running at http://${host}:${port}`);
});
