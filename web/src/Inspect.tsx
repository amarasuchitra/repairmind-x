import { useEffect, useRef, useState } from "react";

interface ProductRow {
  id: string;
  name: string;
  has_detector: boolean;
}

interface JobItem {
  index: number;
  name: string;
  verdict: "good" | "defective" | "uncertain" | "error";
  score: number | null;
  reason: string;
}

interface JobStatus {
  job_id: string;
  product_name: string;
  status: "queued" | "running" | "done" | "failed";
  message: string;
  total: number;
  processed: number;
  counts: Record<JobItem["verdict"], number>;
  items: JobItem[];
}

const TOKEN_KEY = "rmx.inspectionToken";
const VERDICT_LABEL: Record<JobItem["verdict"], string> = {
  good: "Good",
  defective: "Defective",
  uncertain: "Needs a look",
  error: "Unreadable",
};

function readToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

async function apiError(res: Response): Promise<string> {
  const detail = (await res.json().catch(() => ({}))).detail;
  return typeof detail === "string" ? detail : `Error ${res.status}`;
}

/** Bulk inspection: upload many photos (or ZIPs) of one product, watch progress, download the Excel report. */
export function Inspect({ onBack }: { onBack: () => void }) {
  const [productsList, setProducts] = useState<ProductRow[]>([]);
  const [productId, setProductId] = useState("");
  const [token, setToken] = useState(readToken);
  const [files, setFiles] = useState<File[]>([]);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<JobItem["verdict"] | "all">("all");
  const poll = useRef<number | null>(null);

  useEffect(() => {
    fetch("/api/products")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((rows: ProductRow[]) => {
        setProducts(rows);
        const first = rows.find((r) => r.has_detector);
        if (first) setProductId(first.id);
      })
      .catch(() => setError("Can't reach the RepairMind server. Is the token server running?"));
    return () => {
      if (poll.current) window.clearTimeout(poll.current);
    };
  }, []);

  function auth(): HeadersInit {
    return { Authorization: `Bearer ${token}` };
  }

  async function refresh(jobId: string) {
    const res = await fetch(`/api/inspections/${jobId}`, { headers: auth() });
    if (!res.ok) {
      setError(await apiError(res));
      return;
    }
    const s: JobStatus = await res.json();
    setJob(s);
    if (s.status === "queued" || s.status === "running") {
      poll.current = window.setTimeout(() => refresh(jobId), 1500);
    }
  }

  async function start() {
    setError("");
    setBusy(true);
    setJob(null);
    try {
      try {
        sessionStorage.setItem(TOKEN_KEY, token);
      } catch {
        /* not remembered for this tab; fine */
      }
      const form = new FormData();
      form.append("product_id", productId);
      files.forEach((f) => form.append("files", f, f.name));
      const res = await fetch("/api/inspections", { method: "POST", body: form, headers: auth() });
      if (!res.ok) throw new Error(await apiError(res));
      const { job_id } = await res.json();
      await refresh(job_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    if (!job) return;
    const res = await fetch(`/api/inspections/${job.job_id}/report.xlsx`, { headers: auth() });
    if (!res.ok) {
      setError(await apiError(res));
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = `${job.job_id}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const ready = productsList.some((p) => p.id === productId && p.has_detector);
  const running = job && (job.status === "queued" || job.status === "running");
  const shown = job ? job.items.filter((i) => filter === "all" || i.verdict === filter) : [];

  return (
    <main className="landing inspect">
      <div className="brand">
        <div className="logo" aria-hidden>RM</div>
        <span>RepairMind X</span>
        <button className="ghost" onClick={onBack}>Back</button>
      </div>
      <h1>Bulk inspection</h1>
      <p className="lede">
        Upload photos of many units of one product. Each is checked by that product's trained detector and
        marked good, defective, or needs a human look. You get an Excel report with the evidence.
      </p>

      <section className="notice">
        <label className="field">
          <span>Product</span>
          <select value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">Choose…</option>
            {productsList.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.has_detector}>
                {p.name}{p.has_detector ? "" : " (no trained detector yet)"}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Photos or ZIP files</span>
          <input type="file" multiple accept="image/*,.zip"
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
          <small>{files.length ? `${files.length} file(s) selected` : "JPG, PNG or ZIP. Up to 5,000 images."}</small>
        </label>
        <label className="field">
          <span>Inspection token</span>
          <input type="password" value={token} autoComplete="off" onChange={(e) => setToken(e.target.value)}
            placeholder="RMX_INSPECTION_TOKEN from agent/.env" />
        </label>
        <div className="actions">
          <button className="primary" disabled={!ready || !files.length || !token || busy || Boolean(running)}
            onClick={start}>
            {busy ? "Uploading…" : "Inspect"}
          </button>
        </div>
        {!ready && productsList.length > 0 && (
          <p className="hint">No product has a trained detector yet. Train one with scripts/train_detector.py.</p>
        )}
      </section>

      {error && <p className="error" role="alert">{error}</p>}

      {job && (
        <section className="job" aria-live="polite">
          <div className="job-head">
            <strong>{job.product_name}</strong>
            <span>
              {job.status === "done" || job.status === "failed"
                ? job.message
                : `Inspecting ${job.processed} of ${job.total}…`}
            </span>
          </div>
          <progress max={job.total || 1} value={job.status === "done" ? job.total : job.processed} />
          <div className="counts">
            {(Object.keys(VERDICT_LABEL) as JobItem["verdict"][]).map((v) => (
              <button key={v} className={`count v-${v}`} aria-pressed={filter === v}
                onClick={() => setFilter(filter === v ? "all" : v)}>
                <b>{job.counts[v]}</b> {VERDICT_LABEL[v]}
              </button>
            ))}
          </div>
          {(job.status === "done" || job.status === "failed") && (
            <button className="primary" onClick={download}>Download Excel report</button>
          )}
          {job.status === "done" && job.counts.defective + job.counts.uncertain > 0 && (
            <p className="hint">Have a person confirm defective and needs-a-look items before acting on them.</p>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>#</th><th>File</th><th>Verdict</th><th>Score</th></tr>
              </thead>
              <tbody>
                {shown.slice(0, 500).map((i) => (
                  <tr key={i.index} title={i.reason}>
                    <td>{i.index}</td>
                    <td className="file">{i.name}</td>
                    <td><span className={`pill v-${i.verdict}`}>{VERDICT_LABEL[i.verdict]}</span></td>
                    <td>{i.score === null ? "" : i.score.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length > 500 && <p className="hint">Showing 500 of {shown.length}. The report has all of them.</p>}
          </div>
        </section>
      )}
    </main>
  );
}
