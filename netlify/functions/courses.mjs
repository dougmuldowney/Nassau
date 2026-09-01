import { getStore } from "@netlify/blobs";

// The whole library lives in one blob rather than one blob per course. At this
// scale (tens of courses, a handful of players) a single read is faster than a
// list-then-fetch-each, and it makes a write atomic: read, modify, write back
// under the etag we read, so two people saving at once can't silently drop one
// of the two courses.
const STORE = "nassau";
const KEY = "courses";

// Strong consistency costs a little latency and buys the thing that actually
// matters here: scan a card, and it is in the list on the next screen rather
// than up to a minute later.
const READ = { consistency: "strong", type: "json" };

const MAX_COURSES = 500;
const MAX_NAME = 80;

function isPermutation(arr) {
  if (!Array.isArray(arr) || arr.length !== 18) return false;
  const seen = new Set();
  for (const v of arr) {
    if (!Number.isInteger(v) || v < 1 || v > 18 || seen.has(v)) return false;
    seen.add(v);
  }
  return true;
}

// This endpoint is public, so nothing from the request is trusted. A malformed
// course is rejected outright rather than stored and left to break someone's
// match later -- a bad stroke index is invisible until it silently misallocates
// a shot on the course.
function validate(course) {
  if (!course || typeof course !== "object") return "Course must be an object.";
  const name = typeof course.name === "string" ? course.name.trim() : "";
  if (!name) return "Course name is required.";
  if (name.length > MAX_NAME) return `Course name must be ${MAX_NAME} characters or fewer.`;
  if (course.tee != null && typeof course.tee !== "string") return "Tee must be a string.";
  if ((course.tee || "").length > MAX_NAME) return "Tee name is too long.";
  if (!isPermutation(course.si)) return "Stroke index must be the numbers 1-18, each exactly once.";
  if (!Array.isArray(course.par) || course.par.length !== 18) return "Par must have 18 values.";
  if (!course.par.every((v) => Number.isInteger(v) && v >= 0 && v <= 8)) return "Par values are out of range.";
  if (course.ladiesSi != null && !isPermutation(course.ladiesSi))
    return "Ladies' stroke index must be the numbers 1-18, each exactly once.";
  return null;
}

function clean(course) {
  return {
    name: course.name.trim(),
    tee: (course.tee || "").trim(),
    si: course.si.map(Number),
    par: course.par.map(Number),
    ladiesSi: course.ladiesSi ? course.ladiesSi.map(Number) : null,
    updatedAt: Date.now()
  };
}

// Must match courseKey() in index.html exactly. Each part is trimmed on its own:
// trimming only the joined string leaves inner whitespace on the name, which
// would file " Plateau Club " as a separate course from "Plateau Club".
const keyOf = (c) =>
  ((c.name || "").trim() + "|" + (c.tee || "").trim()).toLowerCase();

// getWithMetadata resolves to null -- not a rejection, and not an empty object --
// when the key has never been written. Destructuring that directly threw a 500
// on every read of an empty store, so the first write could never happen and the
// blob could never come into existence. Read the fields off a possibly-null
// value instead, and treat "missing" as an empty list.
async function readAll(store) {
  let entry = null;
  try {
    entry = await store.getWithMetadata(KEY, READ);
  } catch {
    entry = null;
  }
  const data = entry ? entry.data : null;
  const etag = entry ? entry.etag : null;
  const courses = data && Array.isArray(data.courses) ? data.courses : [];
  return { courses, etag };
}

// Read-modify-write under the etag we read. On a conflict someone else wrote
// between our read and our write, so we re-read and re-apply rather than
// overwrite their change.
async function mutate(store, apply) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { courses, etag } = await readAll(store);
    const next = apply(courses);
    if (next === null) return courses;
    const opts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
    const res = await store.setJSON(KEY, { courses: next }, opts);
    // `modified: false` means the precondition failed -- someone beat us to it.
    if (!res || res.modified !== false) return next;
  }
  throw new Error("Could not save: the shared list is being updated by someone else. Try again.");
}

export default async (req) => {
  const store = getStore({ name: STORE, consistency: "strong" });

  try {
    if (req.method === "GET") {
      const { courses } = await readAll(store);
      return Response.json({ courses });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => null);
      const err = validate(body && body.course);
      if (err) return Response.json({ error: err }, { status: 400 });
      const entry = clean(body.course);

      const courses = await mutate(store, (list) => {
        const at = list.findIndex((c) => keyOf(c) === keyOf(entry));
        if (at >= 0) {
          const next = list.slice();
          next[at] = entry;
          return next;
        }
        if (list.length >= MAX_COURSES) throw new Error("The shared course list is full.");
        return list.concat([entry]);
      });
      return Response.json({ courses });
    }

    if (req.method === "DELETE") {
      const body = await req.json().catch(() => null);
      const key = body && typeof body.key === "string" ? body.key : "";
      if (!key) return Response.json({ error: "key is required." }, { status: 400 });
      const courses = await mutate(store, (list) => {
        const next = list.filter((c) => keyOf(c) !== key);
        return next.length === list.length ? null : next;
      });
      return Response.json({ courses });
    }

    return Response.json({ error: "Use GET, POST or DELETE." }, { status: 405 });
  } catch (e) {
    return Response.json({ error: e.message || "Course store unavailable." }, { status: 500 });
  }
};
