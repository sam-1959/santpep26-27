# SantPep 26-27

Horaris de pretemporada i temporada 26-27 del CB Sant Josep de Badalona,
per a consulta dels coachs.

**Web pública:** https://sam-1959.github.io/santpep26-27/horaris.html

- `horaris.html` — pàgina de consulta d'horaris (dades incrustades).
- Publicat amb GitHub Actions (`.github/workflows/pages.yml`).

## Avisos WhatsApp de canvis al calendari

El workflow `Actualitza partits` pot enviar un WhatsApp quan detecta canvis a
`partits.html` despres d'importar els calendaris. Si no hi ha secrets de Twilio
configurats, el pas no envia res i el workflow continua.

Secrets necessaris a GitHub Actions:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM` amb format `whatsapp:+14155238886` o `+14155238886`
- `WHATSAPP_RECIPIENTS` com a JSON (`["+34600111222"]`) o llista separada per
  comes/salts de linia
- `WHATSAPP_TEST_RECIPIENT` opcional, per fer proves enviant només a un número
  concret. Si existeix, té prioritat sobre `WHATSAPP_RECIPIENTS`.

Per provar amb el sandbox de Twilio, cada destinatari ha d'haver fet abans
l'alta al sandbox seguint les instruccions de Twilio.

Prova manual:

1. Configura els secrets de Twilio i `WHATSAPP_TEST_RECIPIENT`.
2. Executa el workflow `Actualitza partits` amb l'opció `test_whatsapp=true`.
3. El missatge de prova s'envia només a `WHATSAPP_TEST_RECIPIENT`.

## Avís email de noves peticions de fisio amb Apps Script

Per fer una prova gratuïta d'avís per correu, el formulari pot cridar un Web
App d'Apps Script després de guardar la petició a Firebase. El script manté el
disseny Sant Pep de l'antic avís del Google Form i ara està configurat en mode
prova amb destinatari `ricard.fuste@gmail.com`.

1. Crea un projecte a https://script.google.com/.
2. Enganxa el contingut de `scripts/fisio-email-appscript.js`.
3. Desplega'l com a **Web app**:
   - Execute as: `Me`
   - Who has access: `Anyone`
4. Autoritza l'enviament de correus quan Google ho demani.
5. Copia la URL `/exec` del desplegament.
6. Posa aquesta URL a `APP_SCRIPT_NOTIFY_URL` dins `fisio.html` i publica.

El formulari guarda primer la petició a Firebase. Després crida Apps Script per
enviar l'email. Si l'avís per email falla, la petició continua quedant guardada.
