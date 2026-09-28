# ADR 0006 — No simulated research or document analysis

**Status:** accepted

**Decision.** Research mode instructs models not to claim browsing and the UI states that live web
search is not connected. Documents are only used as context when text was actually extracted
(TXT, DOCX, text-based PDF). Images and scanned PDFs are accepted but marked "not available yet";
the API rejects them as chat context (422) instead of faking an analysis. Demo Mode says it cannot
read documents.
