// index.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const os = require('os');
const { createClient } = require('@supabase/supabase-js');


// Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY, // <-- full access for backend
);

console.log("Supabase key starts with:", process.env.SUPABASE_SERVICE_ROLE_KEY?.substring(0, 12));



// CommonJS-safe fetch
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));


const pendingVoicemails = new Set(); // keep track of CallSids with voicemail 
const pendingNoVoicemail = new Map(); // CallSid -> timeout



// Twilio client
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

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

const fileUpload = require('express-fileupload');

app.use(fileUpload({
  createParentPath: true,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
}));


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
    message: 'Too many requests. Please try again later.',
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

// Improved time parser
function parseTime(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    const match = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
    if (!match) return null;

    let hour = parseInt(match[1], 10);
    let minutes = match[2] ? parseInt(match[2], 10) : 0;
    const ampm = match[3];

    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (!ampm && hour >= 1 && hour <= 12) {
        if (hour < 8) hour += 12; // assume tradie jobs are afternoon
    }

    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minutes, 0, 0);

    if (d < now) {
        d.setDate(d.getDate() + 1);
    }

    return d;
}

// GPT-powered name + intent + description extraction
async function parseNameAndIntent(text) {
    try {
        const gptResp = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
                {
                    role: 'system',
                    content: `You are an AI that extracts structured info from a customer SMS.
Return a JSON object with:
- name: if given, otherwise "Customer"
- intent: short phrase (quote, booking, plumbing issue, electrical job, leaking tap, etc.)
- description: concise 1-sentence summary of what they want`,
                },
                { role: 'user', content: text },
            ],
            temperature: 0,
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

        await client.messages.create({
            body: `⚡️Hi ${name}, your 24/7 assistant is now active ✅`,
            from: assistantNumber,
            to: formattedPhone,
        });

        await client.messages.create({
            body: `📲 Please forward your mobile number to ${assistantNumber} so we can handle missed calls.`,
            from: assistantNumber,
            to: formattedPhone,
        });

        await client.messages.create({
            body: `Tip: Set forwarding to "When Busy" or "When Unanswered". You're all set ⚡️`,
            from: assistantNumber,
            to: formattedPhone,
        });

        console.log(`✅ Onboarding SMS sent to ${formattedPhone}`);
        res.status(200).json({ success: true });
    } catch (err) {
        console.error('❌ Error in /send-sms:', err.message);
        res.status(500).send('Failed to send SMS');
    }
});

// ================= Register new user =================
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
        const { data, error } = await supabase
            .from('users')
            .insert([{ name, business, email, phone, plan: planSelect }]);
        if (error) throw error;

        await client.messages.create({
            body: `⚡️Hi ${name}, welcome to TradeAssist A.I!`,
            from: process.env.TWILIO_PHONE,
            to: phone,
        });

        console.log(`✅ Registered ${name} (${phone})`);
        res.status(200).json({ success: true, user: data[0] });
    } catch (err) {
        console.error('❌ Register failed:', err.message);
        res.status(500).json({ error: 'Registration failed' });
    }
});


// ================= Call-status handler =================
app.post('/call-status', async (req, res) => {
  const { CallStatus, From: rawFrom, CallSid, RecordingUrl } = req.body;
  const from = formatPhone(rawFrom);
  const tradieNumber = process.env.TRADIE_PHONE_NUMBER;

  if (!from) return res.status(400).send('Missing caller number');

  console.log(`[call-status] status=${CallStatus} from=${from} CallSid=${CallSid} RecordingUrl=${RecordingUrl || 'none'}`);

  const convo = conversations[from] || {};
  if (!convo.handledCalls) convo.handledCalls = new Set();

  try {
    // ----------------- Voicemail already present -----------------
    if (CallStatus === 'completed' && RecordingUrl && RecordingUrl.trim() !== '') {
      pendingVoicemails.add(CallSid);

      // Cancel any "no voicemail" timeout
      if (pendingNoVoicemail.has(CallSid)) {
        clearTimeout(pendingNoVoicemail.get(CallSid));
        pendingNoVoicemail.delete(CallSid);
      }

      console.log(`[call-status] Voicemail detected for ${from}, waiting for /voicemail webhook.`);
      return res.status(200).send('Voicemail detected, waiting for transcription');
    }

    // ----------------- Completed call with no RecordingUrl -----------------
    if (CallStatus === 'completed' && (!RecordingUrl || RecordingUrl.trim() === '')) {
      if (convo.handledCalls.has(CallSid) || pendingNoVoicemail.has(CallSid)) {
        return res.status(200).send('Follow-up already scheduled');
      }

      // Schedule a delayed AI follow-up in case no voicemail is left
      const timeout = setTimeout(async () => {
        if (!pendingVoicemails.has(CallSid)) {
          convo.handledCalls.add(CallSid);
          conversations[from] = { ...convo, step: 'voicemail_followup_sent' };

          const transcription = '[No voicemail left]';

          // Notify tradie
          await client.messages.create({
            body: `⚠️ Missed call from ${from}. Admin sent follow-up notification.`,
            from: process.env.TWILIO_PHONE,
            to: tradieNumber
          });

          // AI follow-up to customer
          const gptResp = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
              { role: 'system', content: 'You are a concise Aussie tradie assistant. Ask for name and intent (quote/booking/other).' },
              { role: 'user', content: `Transcription: "${transcription}"` }
            ]
          });

          const aiReply = gptResp.choices[0].message.content.trim();
          if (aiReply && isValidAUSMobile(from)) {
            await client.messages.create({ body: aiReply, from: process.env.TWILIO_PHONE, to: from });
          }

          console.log(`✅ AI follow-up sent for missed call without voicemail: ${from}`);
        }
        pendingNoVoicemail.delete(CallSid);
      }, 15000); // 15s wait for voicemail

      pendingNoVoicemail.set(CallSid, timeout);
      console.log(`[call-status] Scheduled wait for voicemail for ${from}`);
      return res.status(200).send('Scheduled wait for voicemail');
    }

    // ----------------- Busy/no-answer -----------------
    if (['no-answer', 'busy'].includes(CallStatus) && !convo.handledCalls.has(CallSid)) {
      convo.handledCalls.add(CallSid);
      conversations[from] = { ...convo, step: 'voicemail_followup_sent' };

      const transcription = '[No voicemail left]';

      // Notify tradie
      await client.messages.create({
        body: `⚠️ Missed call from ${from}. Admin sent follow-up notification.`,
        from: process.env.TWILIO_PHONE,
        to: tradieNumber
      });

      // AI follow-up to customer
      const gptResp = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are a concise Aussie tradie assistant. Ask for name and intent (quote/booking/other).' },
          { role: 'user', content: `Transcription: "${transcription}"` }
        ]
      });

      const aiReply = gptResp.choices[0].message.content.trim();
      if (aiReply && isValidAUSMobile(from)) {
        await client.messages.create({ body: aiReply, from: process.env.TWILIO_PHONE, to: from });
      }

      console.log(`✅ Busy/no-answer AI follow-up sent for ${from}`);
      return res.status(200).send('AI follow-up sent for busy/no-answer');
    }

  } catch (err) {
    console.error('❌ Error handling call-status:', err.message);
  }

  res.status(200).send('Call status processed');
});


// ===== /voice handler =====
app.post('/voice', async (req, res) => {
  const response = new twilio.twiml.VoiceResponse();

  try {
    const tradieNumber = process.env.TRADIE_PHONE_NUMBER;

    // fetch voicemail greeting from Supabase
    const { data, error } = await supabase
      .from('tradies')
      .select('voicemail_url')
      .eq('phone', tradieNumber)
      .single();

    if (error) {
      console.error("❌ Supabase error fetching voicemail_url:", error.message);
    }

    if (data && data.voicemail_url) {
      // Custom greeting
      response.play(data.voicemail_url);
    } else {
      // Default AI greeting
      response.say("Hi! The tradie is unavailable. Leave a message after the beep.");
    }

    // Record voicemail
    response.record({
      maxLength: 60,
      playBeep: true,
      transcribe: true, // triggers Twilio transcription
      transcribeCallback: process.env.BASE_URL + '/voicemail'
    });

    response.hangup();

  } catch (err) {
    console.error("❌ Error in /voice handler:", err.message);
    response.say("Hi! The tradie is unavailable. Leave a message after the beep.");
    response.record({
      maxLength: 60,
      playBeep: true,
      transcribe: true,
      transcribeCallback: process.env.BASE_URL + '/voicemail'
    });
    response.hangup();
  }

  res.type('text/xml').send(response.toString());
});

// Upload voicemail
app.post('/api/upload-voicemail', async (req, res) => {
  try {
    if (!req.files || !req.files.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const file = req.files.file;
    const tradieNumber = process.env.TRADIE_PHONE_NUMBER;

    // Make sure bucket exists (voicemails)
    const bucketCheck = await supabase.storage.getBucket('voicemails');
    if (!bucketCheck.data) {
      return res.status(500).json({ error: "Voicemail bucket not found" });
    }

    // Upload the file
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('voicemails')
      .upload(`${tradieNumber}/${Date.now()}-${file.name}`, file.data, {
        contentType: file.mimetype,
        upsert: true // overwrite if file exists
      });

    if (uploadError) throw uploadError;

    // Build public URL
    const voicemailUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/voicemails/${uploadData.path}`;

    // Update tradie record in database
    const { error: updateError } = await supabase
      .from('tradies')
      .update({ voicemail_url: voicemailUrl })
      .eq('phone', tradieNumber);

    if (updateError) throw updateError;

    res.json({ url: voicemailUrl });
  } catch (err) {
    console.error("❌ Upload voicemail error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

//reset voicemail

app.post('/api/reset-voicemail', async (req, res) => {
  try {
    const tradieNumber = process.env.TRADIE_PHONE_NUMBER;
    const { error } = await supabase
      .from('tradies')
      .update({ voicemail_url: null })
      .eq('phone', tradieNumber);

    if (error) throw error;
    res.status(200).send('Voicemail reset');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error resetting voicemail');
  }
});



// ================= Transcribe helper =================
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

// ================= Voicemail callback =================
app.post('/voicemail', async (req, res) => {
  const { CallSid, RecordingSid, From: rawFrom } = req.body;
  const from = formatPhone(rawFrom || '');
  const tradieNumber = process.env.TRADIE_PHONE_NUMBER;

  if (!from) return res.status(400).send('Missing caller number');
  console.log(`[voicemail] CallSid=${CallSid} from=${from} RecordingSid=${RecordingSid || 'none'}`);

  if (!RecordingSid) {
    console.log(`[voicemail] No RecordingSid, skipping transcription`);
    return res.status(200).send('No recording to process');
  }

  // Remove pending no-voicemail
  if (CallSid && pendingNoVoicemail.has(CallSid)) {
    clearTimeout(pendingNoVoicemail.get(CallSid));
    pendingNoVoicemail.delete(CallSid);
    console.log(`[voicemail] Cleared no-voicemail timeout for CallSid=${CallSid}`);
  }

  // Always transcribe voicemail
  let transcription = '[Unavailable]';
  try {
    const recordingUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${RecordingSid}.mp3`;
    transcription = await transcribeRecording(recordingUrl);
  } catch (err) {
    console.error('❌ Transcription failed:', err.message);
  }

  // Save conversation state
  const convo = conversations[from] || {};
  conversations[from] = {
    ...convo,
    transcription,
    type: 'voicemail',
    tradie_notified: true,
    ai_followup_sent: convo.ai_followup_sent || false
  };

  try {
    // Notify tradie
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

    // Only send AI follow-up if it hasn't been sent yet
    if (!conversations[from].ai_followup_sent) {
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

      conversations[from].ai_followup_sent = true; // mark as sent
      console.log(`✅ AI follow-up sent to customer for voicemail from ${from}`);
    }

    console.log(`✅ Voicemail processed & tradie notified for ${from}`);
    res.status(200).send('Voicemail processed and tradie notified');
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

    let convo = conversations[from] || { step: 'new', tradie_notified: false, type: 'missed_call_no_voicemail' };

    res.status(200).send('<Response></Response>'); // Immediate Twilio response

    (async () => {
        try {
            let reply = '';

            if (convo.step === 'awaiting_details') {
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

                await client.messages.create({
                    body: `📩 ${convo.type === 'voicemail' ? 'Voicemail received' : 'Missed call from'} ${from} Name: ${info.name} Intent: ${info.intent} Details: ${detailsText} Waiting for call time...`,
                    from: process.env.TWILIO_PHONE,
                    to: tradieNumber,
                });

                try {
                    await supabase.from('messages').insert([{
                        user_id: 'e0a6c24f-8ecf-42fc-b240-7d3e8350e543',
                        from_number: from,
                        type: convo.type,
                        content: body,
                        customer_name: info.name,
                        intent: info.intent,
                        details: detailsText,
                        created_at: new Date().toISOString(),
                    }]);
                } catch (err) {
                    console.error('❌ Supabase insert failed:', err);
                }

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
                                { role: 'user', content: `Customer said: "${body}"` },
                            ],
                        });
                        proposedTime = gptResp.choices[0].message.content.trim();
                    } catch (err) {
                        console.error('❌ OpenAI call failed:', err);
                    }
                }

                if (proposedTime) {
                    reply = `Thanks! Everything is confirmed. We will see you at ${proposedTime}.`;

                    await client.messages.create({
                        body: `✅ Booking confirmed for ${from} Name: ${convo.customer_info.name} Intent: ${convo.customer_info.intent} Details: ${convo.customer_info.description} Call at ${proposedTime}`,
                        from: process.env.TWILIO_PHONE,
                        to: tradieNumber,
                    });

                    try {
                        await supabase.from('bookings').insert([{
                            user_id: 'e0a6c24f-8ecf-42fc-b240-7d3e8350e543',
                            from_number: from,
                            customer_name: convo.customer_info.name,
                            intent: convo.customer_info.intent,
                            details: convo.customer_info.description,
                            proposed_time: proposedTime,
                            created_at: new Date().toISOString(),
                        }]);
                    } catch (err) {
                        console.error('❌ Supabase booking insert failed:', err);
                    }

                    convo.step = 'done';
                } else {
                    try {
                        const gptResp = await openai.chat.completions.create({
                            model: 'gpt-3.5-turbo',
                            messages: [
                                { role: 'system', content: 'You are a concise Aussie tradie assistant. Suggest rescheduling between 1-3pm if customer time is invalid.' },
                                { role: 'user', content: `Customer proposed call time: "${body}".` },
                            ],
                        });
                        reply = gptResp.choices[0].message.content.trim();
                    } catch (err) {
                        console.error('❌ OpenAI reschedule call failed:', err);
                    }
                }
            }

            if (reply) {
                await client.messages.create({
                    body: reply,
                    from: process.env.TWILIO_PHONE,
                    to: from,
                });
            }
        } catch (err) {
            console.error('❌ SMS async processing failed:', err);
        } finally {
            conversations[from] = convo;
        }
    })();
});

// ================= Dashboard API Endpoints =================

// Fetch all messages
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

// Fetch all bookings
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

// Add booking manually (optional)
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
                created_at: new Date().toISOString(),
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
const host = process.env.HOST || '0.0.0.0';
app.listen(port, host, () => console.log(`🚀 Server running at http://${host}:${port}`));

