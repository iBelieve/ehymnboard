import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BoardState } from "../shared/api";
import { getFont } from "../shared/font";
import { renderScreen } from "../shared/render";
import { EMPTY_LINES, linesForScreen, SCREEN_COUNT, withLine, type Lines } from "../shared/screen";
import { fetchScreen, fetchState, saveLines } from "./api";
import { BoardPreview } from "./BoardPreview";
import { DeviceList } from "./DeviceList";

const SCREEN_IDS = Array.from({ length: SCREEN_COUNT }, (_, i) => i + 1);
const REFRESH_MS = 10_000;

export function App() {
  const [state, setState] = useState<BoardState>();
  const [draft, setDraft] = useState<Lines>();
  const [stored, setStored] = useState<Record<number, { etag: string; buffer: Uint8Array }>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const fetching = useRef(new Set<string>());

  const applyState = useCallback((next: BoardState, resetDraft: boolean) => {
    setState(next);
    // Until a load succeeds there's no draft, and the inputs stay disabled.
    setDraft((prev) => (resetDraft || prev === undefined ? next.lines : prev));
  }, []);

  // Load once, then keep device status fresh (like the old 10 s htmx poll).
  useEffect(() => {
    let cancelled = false;
    const load = (first: boolean) =>
      fetchState()
        .then((next) => {
          if (cancelled) return;
          applyState(next, first);
          setLoadError(undefined);
        })
        .catch((e: unknown) => !cancelled && setLoadError(String(e)));
    void load(true);
    const timer = setInterval(() => void load(false), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [applyState]);

  // Fetch the stored bits for any screen whose etag changed, once per etag.
  useEffect(() => {
    for (const { id, etag } of state?.screens ?? []) {
      const key = `${id}:${etag}`;
      if (stored[id]?.etag !== etag && !fetching.current.has(key)) {
        fetching.current.add(key);
        fetchScreen(id)
          .then((buffer) => setStored((prev) => ({ ...prev, [id]: { etag, buffer } })))
          .catch((e: unknown) => setLoadError(String(e)))
          .finally(() => fetching.current.delete(key));
      }
    }
  }, [state?.screens, stored]);

  const dirty = !!state && !!draft && draft.some((line, i) => line !== state.lines[i]);

  // While editing, render the draft in the browser with the same code the
  // server uses; otherwise show exactly what the boards download, rendering
  // the saved lines the same way until those bits arrive.
  const preview = useMemo(() => {
    const lines = dirty ? draft : state?.lines;
    const font = lines && getFont();
    return SCREEN_IDS.map((id) => {
      const current = state?.screens.find((screen) => screen.id === id)?.etag;
      if (!dirty && current !== undefined && stored[id]?.etag === current) {
        return stored[id].buffer;
      }
      return lines && font ? renderScreen(font, ...linesForScreen(lines, id)) : undefined;
    });
  }, [dirty, draft, state, stored]);

  async function save(lines: Lines) {
    setSaving(true);
    setError(undefined);
    try {
      applyState(await saveLines(lines), true);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-8 px-8 py-8 lg:h-dvh lg:grid-cols-2">
      <div
        className="fixed inset-0 bg-cover opacity-20 brightness-75 grayscale-[0.7]"
        style={{ backgroundImage: "url('/church-lent.jpg')" }}
      />
      <div className="z-10 flex flex-col">
        <h1 className="font-display text-5xl tracking-wide text-white max-lg:mb-8">Hymn Board</h1>

        {state && <DeviceList devices={state.devices} firmware={state.firmware} />}

        <div className="flex flex-grow flex-col items-center justify-center">
          <div className="overflow-hidden rounded-2xl border-8 border-transparent bg-white/40 shadow-lg">
            <form
              className="mx-auto flex max-w-sm flex-col gap-4 bg-white p-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (draft) void save(draft);
              }}
            >
              {(draft ?? EMPTY_LINES).map((line, i) => (
                <input
                  key={i}
                  type="text"
                  className="input input-xl input-bordered text-center"
                  aria-label={`Line ${i + 1}`}
                  value={line}
                  disabled={!draft}
                  maxLength={100}
                  data-1p-ignore
                  onChange={(e) => setDraft((prev) => prev && withLine(prev, i, e.target.value))}
                />
              ))}

              {(error ?? loadError) && (
                <div className="text-error text-sm">{error ?? loadError}</div>
              )}

              <div className="mt-4 flex gap-4">
                <button
                  className="btn btn-primary btn-lg flex-grow"
                  type="submit"
                  disabled={!draft || saving}
                >
                  Apply
                </button>
                <button
                  className="btn btn-soft btn-error btn-lg flex-grow"
                  type="button"
                  disabled={!draft || saving}
                  onClick={() => void save([...EMPTY_LINES])}
                >
                  Clear
                </button>
              </div>
              <div className={`text-center text-sm opacity-60 ${dirty ? "" : "invisible"}`}>
                Previewing unsaved changes
              </div>
            </form>
          </div>
        </div>
      </div>
      <BoardPreview screens={preview} />
    </div>
  );
}
