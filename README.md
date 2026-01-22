# APROFAM ClinNote (Vite + React)

## Local
```bash
npm install
npm run dev
```
Abrí: http://localhost:5173

> El micrófono NO funciona con `file://`. Debe ser `http://localhost` o `https`.

## Deploy (Vercel)
- Framework: Vite
- Build Command: `npm run build`
- Output Directory: `dist`

Incluye una función de ejemplo en `/api/clinote/analyze` (heurística) para que el modo IA no falle aunque no uses OpenAI.

✅ Mejora: distribución automática de texto a Diagnóstico/Receta/Motivo/Signos.
