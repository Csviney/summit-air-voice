# Summit Air Voice Agent

An HVAC phone assistant built with Twilio, OpenAI Realtime, and Google Calendar. The model understands the caller. Backend rules assign priority and control booking and transfers. Safety and behavior rules are separate from the conversation guide so the call flow can evolve independently.

One Fastify service handles calls and the demo page. Transcripts are saved to SQLite turn by turn so interrupted calls retain what was captured.

## Try it

**Just want to test the agent? Call +1 (762) 550-2919.** No local setup is needed.

Use fictional service details. For P2–P4, answer the intake questions and give available days over the next week with start and end times.

| Priority | Test scenario | Expected result |
| --- | --- | --- |
| P0 emergency | “There's a fire in my house right now.” | Safety guidance, then hangup. No transfer or booking. |
| P1 critical | “My heat is completely out and my elderly mother lives here.” | Transfer to the configured representative. Failed transfers become urgent follow-ups. |
| P2 urgent | “My AC is completely out.” Report no danger or vulnerable occupants. | Earliest matching calendar opening offered, then booked after confirmation. |
| P3 repair | “My AC still works but isn't cooling well.” Report no danger. | Details and availability saved for follow-up. No direct booking. |
| P4 routine | “I'd like an annual tune-up.” | Details and availability saved for follow-up. No direct booking. |

The agent qualifies requests and routes urgent cases to the right help. Transfers use one configured representative number. Production use would need an after-hours routing policy.

**Service is restricted to Wake, Orange, and Durham counties in North Carolina.** Both the prompt and backend enforce this. Booking requires a complete, confirmed address in one of those counties. The county is caller-reported, not map-verified. Emergency guidance and critical transfers still apply outside the area.

## Review calls

Open the [demo log](https://summit-air-voice-835881188084.us-central1.run.app/demo). It is password protected. Sign in as `demo` and request the password privately. This simple review page stands in for a CRM. Refresh during or after a call to see captured details, priority, outcomes, and the transcript.

Transcripts cover the AI portion only. Saved follow-ups need manual handling; the app sends no messages. Hosted records can reset when the Cloud Run instance is replaced.

## Run locally

Use Node.js 22.12+ and ngrok.

```bash
npm ci
cp .env.example .env
```

Fill in `.env` with OpenAI and Twilio credentials, the transfer destination, and Google Calendar settings. Set `DEMO_PASSWORD` to at least 12 characters. Keep secrets private.

For Google setup, enable the Calendar API and create a Desktop OAuth client. Add its credentials and a dedicated calendar's ID to `.env`. Run `npm run google-auth`, authorize access, and save the returned refresh token.

Run these in separate terminals:

```bash
ngrok http 3000
npm run dev
```

Set `TWILIO_PUBLIC_BASE_URL` to the tunnel's HTTPS origin and restart the server. Configure the test number's Twilio webhooks:

- Incoming voice: `POST https://<tunnel>/twilio/voice`
- Call status changes: `POST https://<tunnel>/twilio/status`

Use a separate Twilio number to keep the hosted demo line live. Test transfers from a phone other than the transfer destination.

Open `http://localhost:3000/demo` with user `demo` and your local password. Records are stored in `var/summit-air.db`.

Run `npm test` and `npm run typecheck` for automated checks. Tests use simulated providers and need no credentials.

## Hosted setup

Cloud Run builds from `Dockerfile`. The service uses one warm instance with a maximum of one instance and a 900-second request timeout. `/health` reports readiness.

Supply the settings from `.env.example` through service configuration and Secret Manager. Use `HOST=0.0.0.0` and set `TWILIO_PUBLIC_BASE_URL` to the service's HTTPS origin. Point both Twilio webhooks above at that origin. Allow public access to Cloud Run; the app checks Twilio signatures and protects the demo page separately.

The container includes only app source and runtime dependencies. Credentials, local records, logs, and temporary probes stay out of Git and deployment uploads. README.md is the only published Markdown file.

## Next steps

Add repeatable model conversation tests and broader voice QA. Production work would also include prompt versioning, cost tracking, stronger transcript redaction, and direct CRM integration with Summit Air's existing process.

Before production use, agree on industry-specific scenarios and qualification rules with the team. Match their CRM workflow so the agent supports the existing process.
