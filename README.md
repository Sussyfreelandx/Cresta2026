# Crestara Construction Autority Website

## Local development

```bash
npm install
npm run dev
```

Open: http://localhost:3000

## Application notifications (optional)

Set env vars to enable:

- Email (SMTP): `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, `SMTP_TO` (optionally `SMTP_USER`, `SMTP_PASS`)
- Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- File download links: `FILE_ACCESS_TOKEN`
- SMS webhook (integration-ready): `SMS_WEBHOOK_URL`
- reCAPTCHA (optional): `RECAPTCHA_SITE_KEY`, `RECAPTCHA_SECRET`
