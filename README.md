# Voce

Web app Next.js per convertire testi lunghi in un unico MP3 tramite Gemini TTS. Il testo libero può essere generato sia in modalità Standard sia in modalità Batch asincrona.

Include una modalità **Crea audioguida**: carica uno o più TXT multilingue strutturati con intestazioni fra separatori `====`, seleziona una lingua comune e genera gli MP3 in coda. Ogni file usa una voce diversa e conserva il nome originale con un suffisso lingua ISO 639-2, per esempio `01_Cattedrale_di_Santa_Maria_del_Fiore_eng.mp3`.

Per i testi lunghi e le code grandi è disponibile la modalità **Batch**. Per il testo libero l'app crea un singolo job Gemini persistente; per le audioguide crea un job separato per ogni file e ne salva l'identificativo nel `localStorage` del browser. Dopo che i job sono stati confermati è possibile chiudere la pagina o spegnere il computer: alla successiva apertura l'app recupera lo stato dai server Google e permette di assemblare e scaricare ogni MP3 completato. I job in attesa vengono controllati automaticamente ogni 30 secondi.

Per flussi molto grandi è disponibile anche **Scegli cartella** nella modalità audioguida. L'app legge tutti i TXT della cartella, crea un job per ogni lingua riconosciuta in ogni file, invia i job a blocchi da 25 con una pausa di 60 secondi tra un blocco e il successivo, e salva gli MP3 nella cartella scelta sul computer, creando sottocartelle `ita`, `eng`, `deu`, ecc.

Con **Scegli cartella MP3** l'utente autorizza una cartella locale. Nei browser Chromium l'app scrive direttamente gli MP3 e crea le sottocartelle per lingua; negli altri browser usa il normale download. Se un risultato Batch non contiene audio per uno o più segmenti, l'app rigenera solo quei segmenti con la modalità TTS standard prima di scaricare l'MP3, così il file finale non resta incompleto.

Il pannello Batch include la pulizia dell'interfaccia: quando tutti i job sono riusciti e gli MP3 sono stati salvati, la lista può essere svuotata automaticamente. La pulizia riguarda solo l'interfaccia e il `localStorage`, non cancella gli MP3 già salvati nella cartella di output.

La modalità Standard usa `GEMINI_TTS_MODEL` (predefinito `gemini-2.5-flash-preview-tts`); la modalità Batch usa `GEMINI_BATCH_TTS_MODEL` (predefinito `gemini-3.1-flash-tts-preview`), perché il modello 2.5 Flash TTS non espone `batchGenerateContent` su tutti i progetti/API.

Ogni segmento delle audioguide include un vincolo linguistico esplicito e identico: il modello riceve lingua, accento nativo, divieto di traduzione e divieto di cambiare lingua in presenza di nomi propri stranieri. Le indicazioni di stile interne sono formulate in inglese neutro per non contaminare l'accento della narrazione.

Prima della generazione vengono esclusi dalla lettura i titoli di paragrafo isolati (Markdown, maiuscoli, racchiusi fra `===`, terminanti con `:`, oppure brevi righe editoriali seguite da un paragrafo lungo). I titoli restano visibili nell'editor e l'interfaccia indica quanti ne verranno esclusi.

Il parser accetta intestazioni linguistiche in più forme, tra cui `ITALIANO`, `=== ITALIANO ===` e `LINGUA: IT | Italiano`, con o senza righe di separazione prima e dopo.

## Avvio locale

1. Installa le dipendenze con `npm install`.
2. Copia `.env.example` in `.env.local` e inserisci la chiave Gemini API. Il login resta disattivato in sviluppo se le tre variabili `APP_*` non sono presenti.
3. Avvia con `npm run dev` e visita `http://localhost:3000`.

La chiave API viene usata esclusivamente nella route server. Il testo viene diviso nel browser in segmenti vicini alle 1.000 battute, preferendo sempre la fine di un paragrafo o di una frase. I segmenti più brevi aiutano Gemini a mantenere velocità e cadenza costanti. Ogni segmento viene sintetizzato con retry automatico; i PCM risultanti vengono concatenati e codificati una sola volta in MP3 mono, 24 kHz, 128 kbps. Se una richiesta fallisce, un nuovo tentativo riprende dal segmento interrotto senza consumare nuovamente la quota per quelli già completati.

## Pubblicazione

Il progetto è pronto per Vercel. Configura `GEMINI_API_KEY` e, facoltativamente, i modelli TTS. In produzione il login è obbligatorio: configura `APP_USERNAME`, `APP_PASSWORD` e `APP_AUTH_SECRET`. Genera il segreto con `openssl rand -hex 32`. La sessione usa un cookie `HttpOnly`, `Secure` e `SameSite=Strict`; anche le route API sono protette.
