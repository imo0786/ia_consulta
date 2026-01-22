import React, { useEffect, useMemo, useRef, useState } from "react";
import jsPDF from "jspdf";

/**
 * ClinNote — Prototipo v3.1 (cliente) + análisis IA (backend)
 * - Dictado: Web Speech API (SpeechRecognition) en es-GT
 * - Auto-sección: si dictás "Diagnóstico: ..." cambia de sección y captura el contenido
 * - IA (opcional): manda SOLO texto (no audio) a tu backend para estructurar campos en “casi tiempo real”
 * - PDF: botón de descarga + vista previa PDF (auto) dentro de la app
 *
 * Requisito: npm i jspdf
 */

const SECTION_DEFS = [
  { key: "motivo", label: "Motivo de la consulta" },
  { key: "antecedentes", label: "Antecedentes" },
  { key: "impresion", label: "Impresión clínica" },
  { key: "signos", label: "Signos vitales" },
  { key: "diagnostico", label: "Diagnóstico" },
  { key: "prescripcion", label: "Prescripción / Receta" },
  { key: "plan", label: "Plan / Indicaciones" },
  { key: "estudios", label: "Estudios solicitados" },
  { key: "referencias", label: "Referencias / Interconsultas" },
  { key: "acuerdos", label: "Acuerdos / Próximos pasos" },
];

const DEFAULT_SECTIONS = SECTION_DEFS.reduce((acc, s) => {
  acc[s.key] = "";
  return acc;
}, {});

const STORAGE_KEY = "clinote_state_v3_1";

function cn(...cls) {
  return cls.filter(Boolean).join(" ");
}

function safeTrim(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function buildPdfDocFromText(text) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);

  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 44;
  const maxW = pageW - margin * 2;
  const lineH = 14;

  const lines = doc.splitTextToSize(String(text || ""), maxW);
  let y = margin;

  for (let i = 0; i < lines.length; i++) {
    if (y > pageH - margin) {
      doc.addPage();
      y = margin;
    }
    doc.text(String(lines[i] ?? ""), margin, y);
    y += lineH;
  }

  return doc;
}

function exportTextToPDF(text, filenameBase = "informe_clinote") {
  const doc = buildPdfDocFromText(text);
  const date = new Date().toISOString().slice(0, 10);
  doc.save(`${filenameBase}_${date}.pdf`);
}

function pdfBlobUrlFromText(text) {
  const doc = buildPdfDocFromText(text);
  const blob = doc.output("blob");
  return URL.createObjectURL(blob);
}

function buildReport(meta, sections, transcript, extra = {}) {
  const lines = [];
  lines.push("INFORME DE CONSULTA (Borrador)");
  lines.push("—".repeat(34));
  lines.push(`Fecha/Hora: ${meta.datetimeLocal || ""}`);
  if (meta.clinician) lines.push(`Médico: ${meta.clinician}`);
  if (meta.site) lines.push(`Sede: ${meta.site}`);
  if (meta.patientId) lines.push(`Paciente (ID): ${meta.patientId}`);
  if (meta.consent) lines.push("Consentimiento: Registrado");
  if (extra.aiUpdatedAt) lines.push(`Último análisis IA: ${extra.aiUpdatedAt}`);
  lines.push("");

  const ordered = [
    "motivo",
    "antecedentes",
    "impresion",
    "signos",
    "diagnostico",
    "prescripcion",
    "plan",
    "estudios",
    "referencias",
    "acuerdos",
  ];

  ordered.forEach((k) => {
    const def = SECTION_DEFS.find((x) => x.key === k);
    if (!def) return;
    const txt = safeTrim(sections[k]);
    lines.push(def.label.toUpperCase());
    lines.push(txt ? txt : "(sin registro)");
    lines.push("");
  });

  if (Array.isArray(extra.alerts) && extra.alerts.length) {
    lines.push("ALERTAS / VALIDACIONES (IA)");
    extra.alerts.forEach((a) => lines.push(`- ${a}`));
    lines.push("");
  }

  if (Array.isArray(extra.questions) && extra.questions.length) {
    lines.push("PREGUNTAS PARA ACLARAR (IA)");
    extra.questions.forEach((q) => lines.push(`- ${q}`));
    lines.push("");
  }

  const t = safeTrim(transcript);
  if (t) {
    lines.push("TRANSCRIPCIÓN COMPLETA");
    lines.push(t);
  }

  return lines.join("\n");
}

function detectSectionHeader(text) {
  const t = safeTrim(text);
  if (!t) return { key: null, cleaned: "" };

  const headers = [
    { key: "motivo", re: /^(motivo(\s+de(\s+la)?)?\s+(consulta|la\s+consulta|de\s+consulta)?)(\s*[:\-])\s*/i },
    { key: "antecedentes", re: /^(antecedentes|historia\s+cl[ií]nica|hx)(\s*[:\-])\s*/i },
    { key: "impresion", re: /^(impresi[oó]n(\s+cl[ií]nica)?)(\s*[:\-])\s*/i },
    { key: "signos", re: /^(signos\s+vitales|vitales)(\s*[:\-])\s*/i },
    { key: "diagnostico", re: /^(diagn[oó]stico|dx)(\s*[:\-])\s*/i },
    { key: "prescripcion", re: /^(prescripci[oó]n|receta|medicaci[oó]n)(\s*[:\-])\s*/i },
    { key: "plan", re: /^(plan|indicaciones)(\s*[:\-])\s*/i },
    { key: "estudios", re: /^(estudios\s+solicitados|laboratorio|imagenolog[ií]a|ex[aá]menes)(\s*[:\-])\s*/i },
    { key: "referencias", re: /^(referencias|interconsulta|referir)(\s*[:\-])\s*/i },
    { key: "acuerdos", re: /^(acuerdos|pr[oó]ximos\s+pasos|seguimiento)(\s*[:\-])\s*/i },
  ];

  for (const h of headers) {
    if (h.re.test(t)) {
      const cleaned = safeTrim(t.replace(h.re, ""));
      return { key: h.key, cleaned };
    }
  }

  return { key: null, cleaned: t };
}

export default function App() {
  const SpeechRecognition =
    typeof window !== "undefined" &&
    (window.SpeechRecognition || window.webkitSpeechRecognition);

  // ---- Estados UI ----
  const [mode, setMode] = useState("section"); // section | free
  const [activeSection, setActiveSection] = useState("motivo");
  const [autoSection, setAutoSection] = useState(true);
  const [persistLocal, setPersistLocal] = useState(true);
  const [pdfPreview, setPdfPreview] = useState(true);

  // ---- IA ----
  const [aiEnabled, setAiEnabled] = useState(true);
  const [aiStatus, setAiStatus] = useState("idle"); // idle | analyzing | error
  const [aiError, setAiError] = useState("");
  const [aiSections, setAiSections] = useState({ ...DEFAULT_SECTIONS });
  const [aiAlerts, setAiAlerts] = useState([]);
  const [aiQuestions, setAiQuestions] = useState([]);
  const [aiUpdatedAt, setAiUpdatedAt] = useState("");

  // ---- Dictado ----
  const [isListening, setIsListening] = useState(false);
  const [supportsSpeech, setSupportsSpeech] = useState(!!SpeechRecognition);
  const [permissionError, setPermissionError] = useState("");
  const [interim, setInterim] = useState("");

  // ---- Datos ----
  const [meta, setMeta] = useState({
    datetimeLocal: new Date().toLocaleString("es-GT"),
    clinician: "",
    site: "",
    patientId: "",
    consent: false,
  });

  const [sections, setSections] = useState({ ...DEFAULT_SECTIONS });
  const [fullTranscript, setFullTranscript] = useState("");
  const [timeline, setTimeline] = useState([]); // {ts, section, text}

  // ---- Vista previa PDF ----
  const [pdfUrl, setPdfUrl] = useState("");
  const pdfUrlRef = useRef("");

  // ---- Refs para evitar reiniciar reconocimiento ----
  const recognitionRef = useRef(null);

  const modeRef = useRef(mode);
  const activeSectionRef = useRef(activeSection);
  const autoSectionRef = useRef(autoSection);
  const aiEnabledRef = useRef(aiEnabled);

  const metaRef = useRef(meta);
  const timelineRef = useRef(timeline);
  const transcriptRef = useRef(fullTranscript);
  const aiSectionsRef = useRef(aiSections);
  const aiAlertsRef = useRef(aiAlerts);
  const aiQuestionsRef = useRef(aiQuestions);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { activeSectionRef.current = activeSection; }, [activeSection]);
  useEffect(() => { autoSectionRef.current = autoSection; }, [autoSection]);
  useEffect(() => { aiEnabledRef.current = aiEnabled; }, [aiEnabled]);

  useEffect(() => { metaRef.current = meta; }, [meta]);
  useEffect(() => { timelineRef.current = timeline; }, [timeline]);
  useEffect(() => { transcriptRef.current = fullTranscript; }, [fullTranscript]);
  useEffect(() => { aiSectionsRef.current = aiSections; }, [aiSections]);
  useEffect(() => { aiAlertsRef.current = aiAlerts; }, [aiAlerts]);
  useEffect(() => { aiQuestionsRef.current = aiQuestions; }, [aiQuestions]);

  // ---- Cola IA ----
  const pendingTextRef = useRef([]);
  const aiTimerRef = useRef(null);
  const aiInFlightRef = useRef(false);

  const enqueueAI = (text) => {
    if (!aiEnabledRef.current) return;
    const t = safeTrim(text);
    if (!t) return;

    pendingTextRef.current.push(t);

    if (aiTimerRef.current) clearTimeout(aiTimerRef.current);
    aiTimerRef.current = setTimeout(() => {
      flushAI();
    }, 900);
  };

  const flushAI = async () => {
    if (!aiEnabledRef.current) return;
    if (aiInFlightRef.current) return;

    const batch = pendingTextRef.current;
    if (!batch.length) return;

    aiInFlightRef.current = true;
    setAiStatus("analyzing");
    setAiError("");

    const ctxTimeline = (timelineRef.current || []).slice(-20).map((t) => t.text).join(" ");
    const ctxTranscript = safeTrim(transcriptRef.current || "").slice(-4000);
    const delta = batch.join(" ");
    pendingTextRef.current = [];

    try {
      const res = await fetch("/api/clinote/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meta: metaRef.current,
          current: {
            sections: aiSectionsRef.current,
            alerts: aiAlertsRef.current,
            questions: aiQuestionsRef.current,
          },
          input: {
            delta_text: delta,
            timeline_context: ctxTimeline,
            transcript_context: ctxTranscript,
          },
        }),
      });

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || `HTTP ${res.status}`);
      }

      const data = await res.json();
      if (data?.sections) setAiSections((p) => ({ ...p, ...data.sections }));
      if (Array.isArray(data?.alerts)) setAiAlerts(data.alerts);
      if (Array.isArray(data?.questions)) setAiQuestions(data.questions);
      setAiUpdatedAt(new Date().toLocaleString("es-GT"));
      setAiStatus("idle");
    } catch (e) {
      setAiStatus("error");
      setAiError(e?.message ? String(e.message).slice(0, 500) : "Error IA");
      pendingTextRef.current = [delta, ...pendingTextRef.current];
    } finally {
      aiInFlightRef.current = false;
    }
  };

  // ---- Reportes ----
  const reportManual = useMemo(() => buildReport(meta, sections, fullTranscript, {}), [meta, sections, fullTranscript]);

  const reportAI = useMemo(
    () => buildReport(meta, aiSections, fullTranscript, { aiUpdatedAt, alerts: aiAlerts, questions: aiQuestions }),
    [meta, aiSections, fullTranscript, aiUpdatedAt, aiAlerts, aiQuestions]
  );

  const effectiveReport = aiEnabled ? reportAI : reportManual;

  // ---- PDF en tiempo real (preview) ----
  useEffect(() => {
    if (!pdfPreview) {
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
      pdfUrlRef.current = "";
      setPdfUrl("");
      return;
    }

    const t = setTimeout(() => {
      try {
        const url = pdfBlobUrlFromText(effectiveReport || "");
        if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
        pdfUrlRef.current = url;
        setPdfUrl(url);
      } catch {
        // ignore
      }
    }, 900);

    return () => clearTimeout(t);
  }, [pdfPreview, effectiveReport]);

  const sectionCompleteness = useMemo(() => {
    const required = ["motivo", "antecedentes", "impresion", "signos", "diagnostico", "prescripcion"];
    const src = aiEnabled ? aiSections : sections;
    const done = required.filter((k) => safeTrim(src[k]).length > 0).length;
    return { done, total: required.length };
  }, [aiEnabled, aiSections, sections]);

  // ---- Cargar / guardar local ----
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);

      if (s?.meta) setMeta((p) => ({ ...p, ...s.meta }));
      if (s?.sections) setSections((p) => ({ ...p, ...s.sections }));
      if (s?.aiSections) setAiSections((p) => ({ ...p, ...s.aiSections }));
      if (typeof s?.fullTranscript === "string") setFullTranscript(s.fullTranscript);
      if (Array.isArray(s?.timeline)) setTimeline(s.timeline);
      if (s?.mode) setMode(s.mode);
      if (s?.activeSection) setActiveSection(s.activeSection);
      if (typeof s?.autoSection === "boolean") setAutoSection(s.autoSection);
      if (typeof s?.persistLocal === "boolean") setPersistLocal(s.persistLocal);
      if (typeof s?.aiEnabled === "boolean") setAiEnabled(s.aiEnabled);
      if (typeof s?.pdfPreview === "boolean") setPdfPreview(s.pdfPreview);
      if (Array.isArray(s?.aiAlerts)) setAiAlerts(s.aiAlerts);
      if (Array.isArray(s?.aiQuestions)) setAiQuestions(s.aiQuestions);
      if (typeof s?.aiUpdatedAt === "string") setAiUpdatedAt(s.aiUpdatedAt);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!persistLocal) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            meta,
            sections,
            aiSections,
            fullTranscript,
            timeline,
            mode,
            activeSection,
            autoSection,
            persistLocal,
            aiEnabled,
            pdfPreview,
            aiAlerts,
            aiQuestions,
            aiUpdatedAt,
            savedAt: new Date().toISOString(),
          })
        );
      } catch {
        // ignore
      }
    }, 350);

    return () => clearTimeout(t);
  }, [
    meta,
    sections,
    aiSections,
    fullTranscript,
    timeline,
    mode,
    activeSection,
    autoSection,
    persistLocal,
    aiEnabled,
    pdfPreview,
    aiAlerts,
    aiQuestions,
    aiUpdatedAt,
  ]);

  // ---- Support ----
  useEffect(() => {
    setSupportsSpeech(!!SpeechRecognition);
  }, [SpeechRecognition]);

  // ---- Crear recognition SOLO una vez ----
  useEffect(() => {
    if (!SpeechRecognition) return;

    const rec = new SpeechRecognition();
    rec.lang = "es-GT";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      let finalChunk = "";
      let interimChunk = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const txt = res[0]?.transcript || "";
        if (res.isFinal) finalChunk += txt;
        else interimChunk += txt;
      }

      const finalRaw = safeTrim(finalChunk);
      const interimTxt = safeTrim(interimChunk);
      setInterim(interimTxt);

      if (!finalRaw) return;

      const stamp = new Date().toLocaleTimeString("es-GT");

      // Autosección por encabezado
      let target = activeSectionRef.current;
      let toInsert = finalRaw;

      if (autoSectionRef.current) {
        const d = detectSectionHeader(finalRaw);
        if (d.key) {
          target = d.key;
          toInsert = d.cleaned || "";
          setActiveSection(d.key);
        }
      }

      setTimeline((prev) => [...prev, { ts: stamp, section: modeRef.current === "section" ? target : "(libre)", text: finalRaw }]);

      if (modeRef.current === "section") {
        setSections((prev) => ({ ...prev, [target]: safeTrim(`${prev[target]} ${toInsert}`) }));
      } else {
        setFullTranscript((prev) => safeTrim(`${prev} ${finalRaw}`));
      }

      enqueueAI(finalRaw);
    };

    rec.onerror = (e) => {
      const msg = e?.error ? String(e.error) : "Error desconocido";
      setPermissionError(msg);
      setIsListening(false);
    };

    rec.onend = () => {
      setIsListening(false);
      setInterim("");
    };

    recognitionRef.current = rec;

    return () => {
      try { rec.stop(); } catch {}
      recognitionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [SpeechRecognition]);

  const requestMicPermission = async () => {
    setPermissionError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      return true;
    } catch (err) {
      const name = err?.name || "Error";
      if (name === "NotAllowedError") {
        setPermissionError("Permiso denegado. En el candado de la URL poné Micrófono: Permitir y recargá.");
      } else if (name === "SecurityError") {
        setPermissionError("Contexto no seguro. Abrilo en https o en http://localhost (NO file://).");
      } else if (name === "NotReadableError") {
        setPermissionError("El micrófono está ocupado por otra app (Teams/Zoom) o el driver falló.");
      } else if (name === "NotFoundError") {
        setPermissionError("No se detecta micrófono (desconectado o deshabilitado).");
      } else {
        setPermissionError("No se pudo acceder al micrófono. Revisa permisos del navegador.");
      }
      return false;
    }
  };

  const start = async () => {
    setPermissionError("");
    if (!supportsSpeech) return;

    const ok = await requestMicPermission();
    if (!ok) return;

    try {
      recognitionRef.current?.start();
      setIsListening(true);
    } catch {
      setPermissionError("No se pudo iniciar el dictado. Si ya estaba activo, detenelo y volvé a intentar.");
      setIsListening(false);
    }
  };

  const stop = () => {
    try { recognitionRef.current?.stop(); } catch {}
    setIsListening(false);
    setInterim("");
    setTimeout(() => flushAI(), 0);
  };

  const toggleMic = () => {
    if (isListening) stop();
    else start();
  };

  const clearAll = () => {
    setSections({ ...DEFAULT_SECTIONS });
    setAiSections({ ...DEFAULT_SECTIONS });
    setAiAlerts([]);
    setAiQuestions([]);
    setAiUpdatedAt("");
    setFullTranscript("");
    setInterim("");
    setTimeline([]);
    pendingTextRef.current = [];

    if (persistLocal) {
      try { localStorage.removeItem(STORAGE_KEY); } catch {}
    }
  };

  const applyAIToManual = () => {
    setSections((p) => ({ ...p, ...aiSections }));
  };

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
  };

  const exportPDF = () => {
    exportTextToPDF(effectiveReport, aiEnabled ? "informe_clinote_IA" : "informe_clinote");
  };

  // ---- Neumorphism ----
  const BG = "bg-[#e6ebf2]";
  const CARD = "bg-[#e6ebf2] shadow-[10px_10px_20px_rgba(163,177,198,0.55),-10px_-10px_20px_rgba(255,255,255,0.9)]";
  const INSET = "bg-[#e6ebf2] shadow-[inset_8px_8px_16px_rgba(163,177,198,0.55),inset_-8px_-8px_16px_rgba(255,255,255,0.9)]";
  const BTN = "bg-[#e6ebf2] shadow-[8px_8px_16px_rgba(163,177,198,0.55),-8px_-8px_16px_rgba(255,255,255,0.9)] hover:shadow-[6px_6px_12px_rgba(163,177,198,0.55),-6px_-6px_12px_rgba(255,255,255,0.9)] active:shadow-[inset_6px_6px_12px_rgba(163,177,198,0.55),inset_-6px_-6px_12px_rgba(255,255,255,0.9)]";
  const BTN_PRIMARY = "bg-slate-900 text-white hover:bg-slate-800 active:bg-slate-950";
  const BTN_DANGER = "bg-rose-600 text-white hover:bg-rose-700 active:bg-rose-800";

  return (
    <div
      className={cn("min-h-screen", BG, "text-slate-900")}
      style={{
        backgroundImage:
          "radial-gradient(circle at 20% 10%, rgba(255,255,255,0.6), transparent 45%), radial-gradient(circle at 80% 0%, rgba(255,255,255,0.5), transparent 40%)",
      }}
    >
      <div className="mx-auto max-w-6xl p-4 sm:p-6">
        <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-800">APROFAM ClinNote</h1>
            <p className="text-sm text-slate-600">
              Aplicación para tomar notas clínicas.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("rounded-full px-3 py-1 text-xs font-semibold", INSET, supportsSpeech ? "text-emerald-700" : "text-amber-700")}>
              {supportsSpeech ? "SpeechRecognition disponible" : "SpeechRecognition no disponible"}
            </span>
            <span className={cn("rounded-full px-3 py-1 text-xs font-semibold text-slate-700", INSET)}>
              Campos clave: {sectionCompleteness.done}/{sectionCompleteness.total}
            </span>
          </div>
        </header>

        {permissionError && (
          <div className={cn("mb-4 rounded-2xl p-4 text-sm text-rose-900", CARD)}>
            <div className="font-semibold">Aviso</div>
            <div className="mt-1 break-words">{permissionError}</div>
          </div>
        )}

        {aiEnabled && aiStatus === "error" && (
          <div className={cn("mb-4 rounded-2xl p-4 text-sm text-rose-900", CARD)}>
            <div className="font-semibold">Error IA</div>
            <div className="mt-1 break-words">{aiError || "Error desconocido"}</div>
            <div className="mt-2 text-xs text-slate-700">
              Asegurate de tener el backend levantado en <code>/api/clinote/analyze</code>.
            </div>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-12">
          {/* Panel izquierdo */}
          <div className="lg:col-span-4">
            <div className={cn("rounded-2xl p-4", CARD)}>
              <h2 className="text-sm font-semibold text-slate-700">Control</h2>

              <div className="mt-3 grid gap-3">
                <label className="text-xs font-semibold text-slate-600">Modo</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setMode("section")}
                    className={cn("flex-1 rounded-xl px-3 py-2 text-sm font-semibold", BTN, mode === "section" ? BTN_PRIMARY : "text-slate-800")}
                  >
                    Por secciones
                  </button>
                  <button
                    onClick={() => setMode("free")}
                    className={cn("flex-1 rounded-xl px-3 py-2 text-sm font-semibold", BTN, mode === "free" ? BTN_PRIMARY : "text-slate-800")}
                  >
                    Libre
                  </button>
                </div>

                {mode === "section" && (
                  <div>
                    <label className="text-xs font-semibold text-slate-600">Sección activa</label>
                    <div className={cn("mt-1 rounded-xl px-3 py-2", INSET)}>
                      <select
                        value={activeSection}
                        onChange={(e) => setActiveSection(e.target.value)}
                        className="w-full bg-transparent text-sm text-slate-800 outline-none"
                      >
                        {SECTION_DEFS.map((s) => (
                          <option key={s.key} value={s.key}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">Tip: dictá “Diagnóstico: …” y se cambia solo.</p>
                  </div>
                )}

                <div className={cn("rounded-xl p-3 text-xs text-slate-700", INSET)}>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-semibold">Estado</div>
                      <div className="mt-1">{isListening ? "Escuchando…" : "Inactivo"}</div>
                      <div className="mt-1">
                        IA:{" "}
                        <span className="font-semibold">
                          {aiEnabled ? (aiStatus === "analyzing" ? "Analizando…" : "Activa") : "Apagada"}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={toggleMic}
                      disabled={!supportsSpeech}
                      className={cn(
                        "rounded-xl px-3 py-2 text-sm font-semibold",
                        BTN,
                        isListening ? BTN_DANGER : "bg-emerald-600 text-white hover:bg-emerald-700",
                        !supportsSpeech ? "cursor-not-allowed opacity-60" : ""
                      )}
                    >
                      {isListening ? "Detener" : "Iniciar"}
                    </button>
                  </div>

                  {interim && (
                    <div className="mt-2">
                      <div className="font-semibold">Interim</div>
                      <div className="mt-1 italic">{interim}</div>
                    </div>
                  )}
                </div>

                <div className="grid gap-2">
                  <button onClick={() => copyToClipboard(effectiveReport)} className={cn("rounded-xl px-3 py-2 text-sm font-semibold", BTN, BTN_PRIMARY)}>
                    Copiar informe
                  </button>
                  <button onClick={exportPDF} className={cn("rounded-xl px-3 py-2 text-sm font-semibold text-slate-800", BTN)}>
                    Descargar PDF
                  </button>
                  <button onClick={clearAll} className={cn("rounded-xl px-3 py-2 text-sm font-semibold text-rose-700", BTN)}>
                    Limpiar todo
                  </button>
                </div>

                <div className="grid gap-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={autoSection} onChange={(e) => setAutoSection(e.target.checked)} className="h-4 w-4 rounded" />
                    <span className="text-sm text-slate-700">Auto-sección por encabezados</span>
                  </label>

                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={persistLocal} onChange={(e) => setPersistLocal(e.target.checked)} className="h-4 w-4 rounded" />
                    <span className="text-sm text-slate-700">Guardar local (este navegador)</span>
                  </label>

                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={aiEnabled} onChange={(e) => setAiEnabled(e.target.checked)} className="h-4 w-4 rounded" />
                    <span className="text-sm text-slate-700">Analizar con IA (backend)</span>
                  </label>

                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={pdfPreview} onChange={(e) => setPdfPreview(e.target.checked)} className="h-4 w-4 rounded" />
                    <span className="text-sm text-slate-700">Vista previa PDF (auto)</span>
                  </label>
                </div>

                <button
                  onClick={applyAIToManual}
                  disabled={!aiEnabled}
                  className={cn("rounded-xl px-3 py-2 text-sm font-semibold text-slate-800", BTN, !aiEnabled ? "opacity-60 cursor-not-allowed" : "")}
                >
                  Aplicar IA a nota manual
                </button>
              </div>
            </div>

            <div className={cn("mt-4 rounded-2xl p-4", CARD)}>
              <h2 className="text-sm font-semibold text-slate-700">Metadatos</h2>
              <div className="mt-3 grid gap-3">
                <label className="text-xs font-semibold text-slate-600">Fecha/Hora</label>
                <div className={cn("rounded-xl px-3 py-2", INSET)}>
                  <input value={meta.datetimeLocal} onChange={(e) => setMeta((p) => ({ ...p, datetimeLocal: e.target.value }))} className="w-full bg-transparent text-sm text-slate-800 outline-none" />
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-xs font-semibold text-slate-600">Médico</label>
                    <div className={cn("mt-1 rounded-xl px-3 py-2", INSET)}>
                      <input value={meta.clinician} onChange={(e) => setMeta((p) => ({ ...p, clinician: e.target.value }))} className="w-full bg-transparent text-sm text-slate-800 outline-none" />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-600">Sede</label>
                    <div className={cn("mt-1 rounded-xl px-3 py-2", INSET)}>
                      <input value={meta.site} onChange={(e) => setMeta((p) => ({ ...p, site: e.target.value }))} className="w-full bg-transparent text-sm text-slate-800 outline-none" />
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-600">Paciente (ID)</label>
                  <div className={cn("mt-1 rounded-xl px-3 py-2", INSET)}>
                    <input value={meta.patientId} onChange={(e) => setMeta((p) => ({ ...p, patientId: e.target.value }))} className="w-full bg-transparent text-sm text-slate-800 outline-none" />
                  </div>
                </div>

                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={meta.consent} onChange={(e) => setMeta((p) => ({ ...p, consent: e.target.checked }))} className="h-4 w-4 rounded" />
                  <span className="text-sm text-slate-700">Consentimiento registrado</span>
                </label>
              </div>
            </div>
          </div>

          {/* Panel derecho */}
          <div className="lg:col-span-8">
            <div className={cn("rounded-2xl p-4", CARD)}>
              <h2 className="text-sm font-semibold text-slate-700">Nota clínica (manual)</h2>
              <div className="mt-4 grid gap-3">
                {SECTION_DEFS.map((s) => (
                  <div key={s.key} className={cn("rounded-2xl p-3", INSET, activeSection === s.key && mode === "section" ? "outline outline-2 outline-slate-700" : "")}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold text-slate-800">{s.label}</div>
                      {mode === "section" && (
                        <button onClick={() => setActiveSection(s.key)} className={cn("rounded-full px-3 py-1 text-xs font-semibold", BTN, activeSection === s.key ? BTN_PRIMARY : "text-slate-800")}>
                          {activeSection === s.key ? "Activa" : "Activar"}
                        </button>
                      )}
                    </div>

                    <textarea
                      value={sections[s.key]}
                      onChange={(e) => setSections((p) => ({ ...p, [s.key]: e.target.value }))}
                      rows={s.key === "motivo" ? 3 : 4}
                      className="mt-2 w-full resize-y rounded-xl bg-transparent px-2 py-2 text-sm text-slate-800 outline-none placeholder:text-slate-500"
                      placeholder={`Escribí o dictá aquí: ${s.label}`}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div className={cn("rounded-2xl p-4", CARD)}>
                <h2 className="text-sm font-semibold text-slate-700">Transcripción</h2>
                <div className={cn("mt-3 rounded-xl p-3", INSET)}>
                  <textarea value={fullTranscript} onChange={(e) => setFullTranscript(e.target.value)} rows={10} className="w-full resize-y bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-500" />
                </div>
              </div>

              <div className={cn("rounded-2xl p-4", CARD)}>
                <h2 className="text-sm font-semibold text-slate-700">Informe IA (exportable)</h2>
                <div className={cn("mt-3 rounded-xl p-3", INSET)}>
                  <textarea value={reportAI} readOnly rows={10} className="w-full resize-y bg-transparent text-sm text-slate-800 outline-none" />
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button onClick={() => copyToClipboard(reportAI)} className={cn("rounded-xl px-3 py-2 text-sm font-semibold", BTN, BTN_PRIMARY)}>
                    Copiar IA
                  </button>
                  <button onClick={exportPDF} className={cn("rounded-xl px-3 py-2 text-sm font-semibold text-slate-800", BTN)}>
                    Descargar PDF
                  </button>
                </div>
              </div>
            </div>

            {pdfPreview && (
              <div className={cn("mt-4 rounded-2xl p-4", CARD)}>
                <h2 className="text-sm font-semibold text-slate-700">PDF en tiempo real</h2>
                <p className="mt-1 text-xs text-slate-600">Se actualiza solo (cada ~1 segundo) con el informe actual.</p>
                <div className={cn("mt-3 rounded-xl overflow-hidden", INSET)}>
                  {pdfUrl ? (
                    <iframe title="PDF preview" src={pdfUrl} className="h-[520px] w-full" />
                  ) : (
                    <div className="p-3 text-sm text-slate-600">(Generando PDF…)</div>
                  )}
                </div>
              </div>
            )}

            <div className={cn("mt-4 rounded-2xl p-4", CARD)}>
              <h2 className="text-sm font-semibold text-slate-700">Línea de tiempo</h2>
              <div className={cn("mt-3 max-h-72 overflow-auto rounded-xl p-2", INSET)}>
                {timeline.length === 0 ? (
                  <div className="p-2 text-sm text-slate-600">(Aún sin registros)</div>
                ) : (
                  <ul className="space-y-2">
                    {timeline.slice().reverse().map((item, idx) => (
                      <li key={`${item.ts}-${idx}`} className={cn("rounded-xl p-3", BG, "shadow-[4px_4px_10px_rgba(163,177,198,0.35),-4px_-4px_10px_rgba(255,255,255,0.75)]")}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold text-slate-700", INSET)}>{item.ts}</span>
                          <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold text-slate-700", INSET)}>
                            {SECTION_DEFS.find((s) => s.key === item.section)?.label || item.section}
                          </span>
                        </div>
                        <div className="mt-1 text-sm text-slate-800">{item.text}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className={cn("mt-4 rounded-2xl p-4 text-sm text-slate-700", CARD)}>
              <div className="font-semibold">Nota rápida</div>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>El navegador transcribe. El backend solo recibe <b>texto</b> para análisis IA.</li>
                <li>El PDF en preview no se “descarga”; para guardar el archivo usá <b>Descargar PDF</b>.</li>
                <li>IA usa <code>delta_text</code> + contexto recortado; así va “armando” el informe.</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* Botón flotante mic */}
      <button
        onClick={toggleMic}
        disabled={!supportsSpeech}
        className={cn(
          "fixed bottom-5 right-5 h-14 w-14 rounded-full text-xl font-bold",
          BTN,
          isListening ? "bg-rose-600 text-white" : "bg-emerald-600 text-white",
          !supportsSpeech ? "cursor-not-allowed opacity-60" : ""
        )}
        title={isListening ? "Detener" : "Iniciar"}
      >
        {isListening ? "■" : "🎤"}
      </button>
    </div>
  );
}
