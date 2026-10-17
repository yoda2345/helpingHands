const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const Anthropic = require("@anthropic-ai/sdk");
const db = require("./db");

const PORT = process.env.PORT || 3000;
const MODEL = "claude-sonnet-5-5";
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB
const CRITERIA_PATH = path.join(
  __dirname,
  "ihh-recuperative-care-admission-criteria.pdf"
);

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "ANTHROPIC_API_KEY is not set. Set it in your environment before starting the server."
  );
  process.exit(1);
}

if (!fs.existsSync(CRITERIA_PATH)) {
  console.error(`Admission criteria PDF not found at ${CRITERIA_PATH}`);
  process.exit(1);
}

const CRITERIA_BASE64 = fs.readFileSync(CRITERIA_PATH).toString("base64");
const MAX_HISTORY = 100;

const anthropic = new Anthropic();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      return cb(new Error("Only PDF files are accepted."));
    }
    cb(null, true);
  },
});

const app = express();
app.use(express.json());
app.use(express.static("public"));

const ELIGIBILITY_PROMPT = `The first document is "Recuperative Care Admission Criteria and Eligibility
Outline" - the official admission guidelines for a recuperative care program.
The second document is a patient intake/referral form (which may include
forms, medication records, vitals logs, and progress notes).

Using ONLY the criteria in the first document, determine whether the patient
in the second document is eligible for recuperative care admission.

Respond with ONLY a single valid JSON object (no markdown code fences, no
text before or after it) matching exactly this shape:

{
  "determination": "eligible" | "ineligible" | "needs_more_info",
  "summary": "one or two sentence plain-language overview of the determination",
  "criteria": [
    {
      "name": "short name of the criterion, e.g. 'General admission criteria' or 'Ambulation (100 ft)'",
      "status": "met" | "not_met" | "unknown",
      "explanation": "one or two sentences citing the specific fact from the intake form that supports this"
    }
  ],
  "disqualifying_factors": ["each explicit match to an 'Ineligible' criterion, as a short string"],
  "open_questions": ["each unanswered 'Associated Question' or missing document needed to finalize the determination"]
}

Include an entry in "criteria" for every admission criterion that is
relevant given this patient's diagnoses (general admission criteria, ADLs,
mobility, mental health, cognition, infection control, and any applicable
disease-specific criteria). Use "needs_more_info" as the overall
determination whenever one or more criteria are "unknown" and none are
disqualifying. Do not invent information that is not present in the intake
form - mark a criterion "unknown" and add a note to "open_questions" when a
field is blank, redacted, or illegible rather than assuming a value.`;

const MAX_OUTPUT_TOKENS = 8192;
const APPROX_CHARS_PER_TOKEN = 4;

app.post("/api/summarize", (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      const stream = anthropic.messages.stream({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: CRITERIA_BASE64,
                },
                title: "Recuperative Care Admission Criteria",
              },
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: req.file.buffer.toString("base64"),
                },
                title: "Patient Intake Form",
              },
              {
                type: "text",
                text: ELIGIBILITY_PROMPT,
              },
            ],
          },
        ],
      });

      stream.on("text", (_delta, snapshot) => {
        const estimatedTokens = snapshot.length / APPROX_CHARS_PER_TOKEN;
        const percent = Math.min(95, Math.round((estimatedTokens / MAX_OUTPUT_TOKENS) * 100));
        send({ type: "progress", percent });
      });

      const message = await stream.finalMessage();

      const rawText = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

      let result;
      try {
        const jsonText = rawText
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/, "");
        result = JSON.parse(jsonText);
      } catch (parseErr) {
        console.error("Failed to parse model output as JSON:", parseErr, rawText);
        send({
          type: "error",
          error:
            "The model's response could not be parsed. Try again, or check the server log for the raw output.",
        });
        return res.end();
      }

      if (!["eligible", "ineligible", "needs_more_info"].includes(result.determination)) {
        result.determination = "needs_more_info";
      }

      db.insertHistory({
        id: Date.now() + Math.random().toString(36).slice(2),
        timestamp: new Date().toISOString(),
        filename: req.file.originalname,
        determination: result.determination,
        summary: result.summary || "",
        result,
        review: null,
        reviewedAt: null,
      });
      db.trimHistory(MAX_HISTORY);

      send({ type: "progress", percent: 100 });
      send({ type: "done", result });
      res.end();
    } catch (apiErr) {
      let detail = apiErr.message;
      if (apiErr instanceof Anthropic.AuthenticationError) {
        detail = "Invalid or missing ANTHROPIC_API_KEY.";
      } else if (apiErr instanceof Anthropic.RateLimitError) {
        detail = "Rate limited by the Anthropic API. Try again shortly.";
      } else if (apiErr instanceof Anthropic.BadRequestError) {
        detail = `Bad request: ${apiErr.message}`;
      } else if (apiErr instanceof Anthropic.APIError) {
        detail = `API error (${apiErr.status}): ${apiErr.message}`;
      }
      console.error("Anthropic API error:", apiErr);
      send({ type: "error", error: `Failed to determine eligibility. ${detail}` });
      res.end();
    }
  });
});

app.get("/api/history", (req, res) => {
  res.json({ history: db.getAllHistory() });
});

app.post("/api/history/:id/review", (req, res) => {
  const { decision } = req.body || {};
  if (!["approved", "disapproved"].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'approved' or 'disapproved'." });
  }

  const existing = db.getHistoryById(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: "History entry not found." });
  }

  const entry = db.updateReview(req.params.id, decision, new Date().toISOString());
  res.json({ entry });
});

app.listen(PORT, () => {
  console.log(`Recuperative care eligibility checker running at http://localhost:${PORT}`);
});
