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

// Tracks CallSids for calls that are expected to have a voicemail
const pendingVoicemails = new Set();

// OpenAI client
const OpenAI = require('openai').default;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
const port = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// Serve static assets
app.use(express.static(path.join(__dirname, 'public')));

// ================= Pages =================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public/login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public/dashboard.html')));
app.get('/success', (req, res) => res.sendFile(path.join(__dirname, 'public/success.html')));

// Admin credentials (testing only)
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password123';

app.post('/dashboard/view', async (req, res) => {
  const { email, password } = req.body;
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
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

// ================= Helpers =================
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

// Persist conversations
const CONVO_FILE = path.join(__dirname, 'conversations.json');
function loadConversations() {
  try {
    if (fs.existsSync(CONVO_FILE)) {
      return JSON.parse(fs.readFileSync(CONVO_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('❌ Failed to load conversations:', err.message);
  }
  return {};
}
function saveConversations() {
  try {
    fs.writeFileSync(CONVO_FILE, JSON.stringify(conversations, null, 2));
  } catch (err) {
    console.error('❌ Failed to save conversations:', err.message);
  }
}
let conversations = loadConversations();
process.on('SIGINT', () => { saveConversations(); process.exit(); });
process.on('SIGTERM', () => { saveConversations(); process.exit(); });

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
    if (hour < 8) hour += 12;
  }
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minutes, 0, 0);
  if (d < now) d.setDate(d.getDate() + 1);
  return d;
}

// ================= Transcription =================
async function transcribeRecording(url) {
  if (!url) return '[No recording URL]';
  try {
    const resp = await fetch(url);
    const buffer = await resp.arrayBuffer();
    const file = new File([buffer], 'voicemail.mp3', { type: 'audio/mpeg' });
    const transcript = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file
    });
    return transcript.text || '[Empty transcription]';
  } catch (err) {
    console.error('❌ transcribeRecording failed:', err.message);
    return '[Transcription failed]';
  }
}

// ================= GPT-powered name + intent =================
async function parseNameAndIntent(text) {
  try {
    const gptResp = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: `
You are an AI that extracts structured info from a customer SMS.
Return valid JSON only with:
{
  "name": "...",
  "intent": "...",
  "description": "..."
}`
        },
        { role: 'user', content: text }
      ],
      temperature: 0
    });
    const raw = gptResp.choices[0].message.content.trim();
    try {
      return JSON.parse(raw);
    } catch {
      console.warn('⚠️ GPT returned non-JSON, falling back.');
      return { name: 'Customer', intent: 'other', description: text };
    }
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
      to: phone
    });
    console.log(`✅ Registered ${name} (${phone})`);
    res.status(200).json({ success: true, user: data[0] });
  } catch (err) {
    console.error('❌ Register failed:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});


// ================= /voice endpoint =================
// Handles incoming calls
app.post('/voice', (req, res) => {
  const response = new twilio.twiml.VoiceResponse();

  const dial = response.dial({
    timeout: 25,              // seconds to ring before fallback
    action: '/voicemail-fallback',
    method: 'POST'
  });
  dial.number(process.env.TRADIE_PHONE_NUMBER);

  res.type('text/xml').send(response.toString());
});

// ================= /voicemail-fallback endpoint =================
// Called when call not answered
app.post('/voicemail-fallback', (req, res) => {
  const response = new twilio.twiml.VoiceResponse();
  response.say('The tradie is unavailable. Please leave a message after the beep.', { voice: 'alice' });
  response.record({
    maxLength: 60,
    playBeep: true,
    transcribe: true,
    transcribeCallback: process.env.BASE_URL + '/voicemail',
  });
  response.hangup();
  res.type('text/xml').send(response.toString());
});

// ================= /call-status endpoint =================
// Tracks completed calls
app.post('/call-status', async (req, res) => {
  const { CallStatus, CallSid, From: rawFrom, RecordingUrl = '' } = req.body;
  const from = formatPhone(rawFrom);

  if (!from) return res.status(400).send('Missing caller number');
  console.log(`[call-status] CallSid=${CallSid}, status=${CallStatus}, recording=${!!RecordingUrl}, from=${from}`);

  try {
    if (CallStatus === 'completed') {
      // If recording not yet received, mark pending
      if (!RecordingUrl) {
        pendingVoicemails.add(CallSid);

        // Fallback to missed call SMS after 40s
        setTimeout(async () => {
          if (pendingVoicemails.has(CallSid)) {
            pendingVoicemails.delete(CallSid);
            console.log(`[call-status] CallSid=${CallSid} no voicemail left, sending missed call SMS`);

            const msg = `G’day, this is ${process.env.TRADIE_NAME} from ${process.env.TRADES_BUSINESS}. Sorry I missed your call — can I grab your name and what you’re after (quote/booking/other)?`;
            await client.messages.create({ body: msg, from: process.env.TWILIO_PHONE, to: from });

            conversations[from] = { step: 'awaiting_details', type: 'missed_call_no_voicemail' };
            saveConversations();

            await client.messages.create({
              body: `⚠️ Missed call from ${from}. Assistant sent follow-up.`,
              from: process.env.TWILIO_PHONE,
              to: process.env.TRADIE_PHONE_NUMBER
            });

            await supabase.from('messages').insert([{
              user_id: 'e0a6c24f-8ecf-42fc-b240-7d3e8350e543',
              from_number: from,
              type: 'missed_call_no_voicemail',
              content: '[No voicemail]',
              created_at: new Date().toISOString()
            }]);
          }
        }, 40000); // 40s timeout
      }
    }
  } catch (err) {
    console.error('❌ Error in call-status:', err.message);
  }

  res.status(200).send('Call status processed');
});

// ================= /voicemail endpoint =================
// Handles voicemail recording + transcription
app.post('/voicemail', async (req, res) => {
  const { RecordingUrl: rawRecording, From: rawFrom, CallSid } = req.body;
  const from = formatPhone(rawFrom);
  const recordingUrl = rawRecording ? `${rawRecording}.mp3` : '';

  if (!from) return res.status(400).send('Missing caller number');
  console.log(`[voicemail] CallSid=${CallSid} from=${from} recordingUrl=${!!recordingUrl}`);

  try {
    if (CallSid && pendingVoicemails.has(CallSid)) {
      pendingVoicemails.delete(CallSid);
      console.log(`[voicemail] Cleared pendingVoicemails for CallSid=${CallSid}`);
    }

    let transcription = '[Unavailable]';
    try { transcription = await transcribeRecording(recordingUrl); }
    catch (err) { console.error('❌ Transcription failed:', err.message); }

    conversations[from] = { step: 'awaiting_details', transcription, type: 'voicemail' };

    await client.messages.create({
      body: `🎙️ Voicemail from ${from}: "${transcription}"`,
      from: process.env.TWILIO_PHONE,
      to: process.env.TRADIE_PHONE_NUMBER
    });

    await supabase.from('messages').insert([{
      user_id: 'e0a6c24f-8ecf-42fc-b240-7d3e8350e543',
      from_number: from,
      type: 'voicemail',
      transcription,
      created_at: new Date().toISOString()
    }]);

    // Optional: AI follow-up SMS
    try {
      const gptResp = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: `You are a concise Aussie tradie assistant. Ask for name and intent, offer to schedule a call between 1-3pm.` },
          { role: 'user', content: `Transcription of voicemail: "${transcription}"` }
        ]
      });
      const aiReply = gptResp.choices[0].message.content.trim();
      if (aiReply && isValidAUSMobile(from)) {
        await client.messages.create({ body: aiReply, from: process.env.TWILIO_PHONE, to: from });
      }
    } catch (err) { console.error('❌ AI follow-up failed:', err.message); }

    saveConversations();
    res.status(200).send('Voicemail processed');
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
  res.status(200).send('<Response></Response>');
  (async () => {
    try {
      let reply = '';
      if (convo.step === 'awaiting_details') {
        let info;
        try { info = await parseNameAndIntent(body); }
        catch { info = { name: 'Customer', intent: 'other', description: body }; }
        convo.customer_info = info;
        let detailsText = info.description || '';
        if (convo.type === 'voicemail' && convo.transcription) {
          detailsText = `${detailsText} (Voicemail: ${convo.transcription})`;
        }
        await client.messages.create({
          body: `📩 ${convo.type === 'voicemail' ? 'Voicemail received' : 'Missed call from'} ${from}
Name: ${info.name}
Intent: ${info.intent}
Details: ${detailsText}
Waiting for call time...`,
          from: process.env.TWILIO_PHONE,
          to: tradieNumber
        });
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
        reply = `Thanks ${info.name}! What time works for a call between 1-3 pm?`;
        convo.step = 'scheduling';
      } else if (convo.step === 'scheduling') {
        let proposedTime = parseTime(body);
        if (!proposedTime) {
          try {
            const gptResp = await openai.chat.completions.create({
              model: 'gpt-3.5-turbo',
              messages: [
                { role: 'system', content: 'Extract a valid call time between 1-3 pm from the customer message.' },
                { role: 'user', content: `Customer said: "${body}"` }
              ]
            });
            proposedTime = parseTime(gptResp.choices[0].message.content.trim());
          } catch (err) {
            console.error('❌ GPT parseTime failed:', err.message);
          }
        }
        if (proposedTime instanceof Date && !isNaN(proposedTime)) {
          convo.proposed_time = proposedTime;
          await client.messages.create({
            body: `📅 Customer ${convo.customer_info?.name || ''} proposes a call at ${proposedTime.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}`,
            from: process.env.TWILIO_PHONE,
            to: tradieNumber
          });
          await supabase.from('appointments').insert([{
            user_id: 'e0a6c24f-8ecf-42fc-b240-7d3e8350e543',
            customer_name: convo.customer_info?.name || 'Unknown',
            customer_number: from,
            proposed_time: proposedTime.toISOString(),
            notes: convo.customer_info?.description || '',
            status: 'pending',
            created_at: new Date().toISOString()
          }]);
          reply = `Sweet, locked in for ${proposedTime.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}. ${process.env.TRADIE_NAME} will call you then ✅`;
          convo.step = 'complete';
        } else {
          reply = `Sorry, I didn’t catch that. What time between 1–3 pm works for a call?`;
        }
      } else {
        reply = `G’day, this is ${process.env.TRADIE_NAME}. Can I grab your name and what you’re after (quote/booking/other)?`;
        convo.step = 'awaiting_details';
      }
      if (reply && isValidAUSMobile(from)) {
        await client.messages.create({ body: reply, from: process.env.TWILIO_PHONE, to: from });
      }
      conversations[from] = convo;
      saveConversations();
    } catch (err) {
      console.error('❌ Error in /sms:', err.message);
    }
  })();
});

// ================= Start server =================
app.listen(port, () => {
  const interfaces = os.networkInterfaces();
  let localIp = 'localhost';
  for (let name in interfaces) {
    for (let iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) localIp = iface.address;
    }
  }
  console.log(`⚡️Server running at http://${localIp}:${port}`);
});

