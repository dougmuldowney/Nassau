import Anthropic from "@anthropic-ai/sdk";

// The stroke index ("handicap") row is the whole point of the scan: it decides
// which holes every player gets a pop on, and a wrong value silently skews the
// match for 18 holes. So the schema forces the model to commit to a value for
// every hole and to report what it could not read, rather than leaving gaps the
// client would have to guess at.
const SCHEMA = {
  type: "object",
  properties: {
    courseName: {
      type: "string",
      description: "Course name as printed. Empty string if not visible."
    },
    teeName: {
      type: "string",
      description:
        "Tee box the par/yardage row belongs to (e.g. 'Blue', 'White'). Empty string if not determinable."
    },
    holes: {
      type: "array",
      description:
        "Exactly 18 entries, hole 1 through hole 18, in order. `si` is the MEN'S stroke index.",
      items: {
        type: "object",
        properties: {
          hole: { type: "integer", description: "Hole number, 1-18." },
          par: { type: "integer", description: "Par for the hole. 0 if unreadable." },
          si: {
            type: "integer",
            description:
              "Men's stroke index / handicap rank for the hole, 1-18. 0 if unreadable."
          }
        },
        required: ["hole", "par", "si"],
        additionalProperties: false
      }
    },
    ladiesSi: {
      type: "array",
      description:
        "The ladies'/women's stroke index row, 18 values in hole order, if the card prints a second handicap row. Empty array if the card has only one. Use 0 for an unreadable value.",
      items: { type: "integer" }
    },
    warnings: {
      type: "array",
      description:
        "Only genuine problems the user must check: glare, a cropped or torn row, ambiguous digits, a row you had to guess at. Do NOT warn about a card simply having two handicap rows -- that is normal and both are captured. Empty array if the read was clean.",
      items: { type: "string" }
    }
  },
  required: ["courseName", "teeName", "holes", "ladiesSi", "warnings"],
  additionalProperties: false
};

const SYSTEM = `You read photographs of golf scorecards and extract the per-hole data.

The row that matters most is the stroke index: it ranks the 18 holes by
difficulty, so across all 18 holes the values are the numbers 1 through 18, each
appearing exactly once. It is labelled "Handicap", "HCP", "HDCP", "Index",
"S.I.", "Stroke Index", "Men's HCP", or similar.

Nearly every card prints TWO handicap rows -- a men's and a ladies'/women's row.
This is normal, not a defect. Put the men's row in \`holes[].si\` and the other in
\`ladiesSi\`. Do not raise a warning about it. If there is genuinely only one
handicap row, use it as the men's row and leave \`ladiesSi\` empty.

Things that are NOT the stroke index, and are the most common ways to get this
wrong:
  - The "HCP" COLUMN on the right-hand edge, next to OUT / IN / TOT / NET / PTS
    / ADJ. That column is for a player's own handicap in stroke play and is
    usually blank. The stroke index is a ROW running across all 18 holes. If
    what you found does not span 18 hole columns, it is the wrong thing.
  - The Par row (values cluster in 3-5).
  - Yardage rows, one per tee colour (values in the hundreds). Tee labels
    sometimes carry course rating and slope like "71.4/144" or "75.9/155" --
    those are not hole data.
  - The hole-number header row (1,2,3...18, strictly ascending -- the stroke
    index row is never in ascending order).
  - Small numbers printed inside hole-diagram thumbnails (green depths, sprinkler
    yardages, "DEPTH 27").

Ignore anything handwritten. Many cards have been played: pencilled scores,
player names, circled numbers, initials, running totals and tick marks fill the
blank scoring rows between the yardage block and the Par row. None of it is
course data. You want only the pre-printed rows.

Scorecards print the front nine and back nine as separate blocks, usually with
OUT / IN / TOTAL summary columns between or after them. Skip those summary
columns and report only the 18 real holes.

Self-check before you answer: almost every course puts the odd stroke indexes
(1,3,5...17) on one nine and the even ones on the other. If your 18 values do
not split that way, or if any number repeats, you have very likely misread a
digit or picked up the wrong row -- look again.

Use 0 for any value you genuinely cannot read, and add a warning naming the
hole. Never invent a digit to complete the 1-18 set -- a flagged gap the user
fixes by hand is far better than a confident wrong number.`;

export default async (req) => {
  if (req.method !== "POST") {
    return Response.json({ error: "POST only" }, { status: 405 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY is not set on this Netlify site." },
      { status: 500 }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const { imageBase64, mediaType } = body || {};
  if (!imageBase64) {
    return Response.json({ error: "imageBase64 is required." }, { status: 400 });
  }
  // Claude accepts these four; the client encodes to JPEG, so this is a guard
  // against a hand-rolled request rather than something the app will trip.
  const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  const media = allowed.includes(mediaType) ? mediaType : "image/jpeg";

  const client = new Anthropic();

  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5",
      max_tokens: 16000,
      // A misread digit costs the user a whole round, so let the model take its
      // time on the smudged ones.
      thinking: { type: "adaptive" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: media, data: imageBase64 } },
            {
              type: "text",
              text:
                "Extract the course name, the tee, and the par and stroke index for all 18 holes from this scorecard."
            }
          ]
        }
      ],
      output_config: { format: { type: "json_schema", schema: SCHEMA } }
    });

    if (response.stop_reason === "refusal") {
      return Response.json(
        { error: "The model declined to process this image." },
        { status: 422 }
      );
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) {
      return Response.json({ error: "No content returned." }, { status: 502 });
    }
    const data = JSON.parse(textBlock.text);

    // Trust nothing for the grid's shape: the client indexes holes[0..17]
    // directly, so normalise to exactly 18 slots here instead of scattering
    // length checks through the UI.
    const byHole = new Map((data.holes || []).map((h) => [Number(h.hole), h]));
    const holes = Array.from({ length: 18 }, (_, i) => {
      const h = byHole.get(i + 1) || {};
      return { hole: i + 1, par: Number(h.par) || 0, si: Number(h.si) || 0 };
    });

    const seen = holes.map((h) => h.si).filter((v) => v >= 1 && v <= 18);
    const siComplete = new Set(seen).size === 18;

    // Only pass the ladies' row through when it is actually usable. A partial
    // second row is worse than none: it would offer the user a choice that
    // silently produces a worse allocation than the men's row they already have.
    const ladiesRaw = Array.isArray(data.ladiesSi) ? data.ladiesSi.map(Number) : [];
    const ladiesSi =
      ladiesRaw.length === 18 && new Set(ladiesRaw.filter((v) => v >= 1 && v <= 18)).size === 18
        ? ladiesRaw
        : [];

    const warnings = Array.isArray(data.warnings) ? data.warnings : [];
    // Cheap structural check the model cannot talk itself out of: almost every
    // course splits odd indexes onto one nine and even onto the other. A card
    // that fails this is usually a misread digit, not an unusual course.
    if (siComplete) {
      const oddFront = holes.slice(0, 9).filter((h) => h.si % 2 === 1).length;
      if (oddFront !== 0 && oddFront !== 9) {
        warnings.push(
          "The stroke indexes do not split odd/even across the two nines, which is unusual — double-check the row before starting."
        );
      }
    }

    return Response.json({
      courseName: data.courseName || "",
      teeName: data.teeName || "",
      holes,
      ladiesSi,
      siComplete,
      warnings
    });
  } catch (err) {
    const status = err?.status || 500;
    return Response.json(
      { error: err?.message || "Scan failed." },
      { status: status >= 400 && status < 600 ? status : 500 }
    );
  }
};
