"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * The hero's booking card: a 10.5-second loop through choosing a session,
 * picking a slot and the booked summary. Illustrative only. The slots are
 * examples, never real availability, and the card is hidden from screen
 * readers because every fact in it is in the page's own text. Hovering pauses
 * it; with reduced motion it shows the booked frame and stays still.
 *
 * Names and prices come in as props from the catalogue, so no price is built
 * here (prices have one source).
 */
export interface DemoSession {
  readonly name: string;
  readonly price: string;
}

const LOOP = 10.5;
const PICK = 2;
const SLOTS = ["Mon 19:00", "Tue 20:30", "Wed 19:00", "Thu 21:00", "Sat 11:00", "Sat 14:00"];
const SLOT_PICK = 2;
const TICK_MS = 80;

const REDUCED = "(prefers-reduced-motion: reduce)";

function subscribeReduced(onChange: () => void) {
  const query = window.matchMedia(REDUCED);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** The visitor asked for less motion. False while rendering on the server. */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia(REDUCED).matches,
    () => false,
  );
}

function stepAt(t: number): 0 | 1 | 2 {
  return t < 3.5 ? 0 : t < 7 ? 1 : 2;
}

function Mono({ children, sage = false }: { children: string; sage?: boolean }) {
  return (
    <span className={`font-mono text-xs ${sage ? "text-accent" : "text-ink-faint"}`}>
      {children}
    </span>
  );
}

function delay(seconds: number) {
  return { animationDelay: `${seconds}s` };
}

export function BookingDemo({
  sessions,
  durationMinutes,
  platform,
}: {
  sessions: readonly DemoSession[];
  durationMinutes: number;
  platform: string;
}) {
  const [clock, setClock] = useState(0);
  const paused = useRef(false);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (reduced) return;
    let last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      // A hidden tab stops the timer; never jump seconds ahead when it returns.
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      if (paused.current || document.hidden) return;
      setClock((prev) => (prev + dt) % LOOP);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [reduced]);

  // Reduced motion: the booked frame, still.
  const t = reduced ? 8 : clock;
  const step = stepAt(t);
  const picked = sessions[PICK] ?? sessions[0];
  const title = "font-serif text-[21px] font-medium text-ink mb-3.5";

  let pane;
  if (step === 0) {
    const on = t > 1.6 ? PICK : Math.min(PICK, Math.floor(t / 0.55));
    pane = (
      <div>
        <div className={title}>Choose a session</div>
        {sessions.map((s, i) => (
          <div
            key={s.name}
            style={delay(i * 0.07)}
            className={`animate-z-in mb-2 flex items-center justify-between rounded-[10px] border px-3.5 py-3 transition-colors duration-250 ${
              i === on ? "border-accent-dot" : "border-line"
            } ${i === on && t > 1.6 ? "bg-accent-soft" : "bg-surface"}`}
          >
            <span className="text-ink text-[14.5px]">{s.name}</span>
            <Mono sage={i === on}>{s.price}</Mono>
          </div>
        ))}
      </div>
    );
  } else if (step === 1) {
    const s = t - 3.5;
    const slot = s > 1.4 ? SLOT_PICK : -1;
    pane = (
      <div>
        <div className={title}>Pick an evening slot</div>
        <div className="-mt-2 mb-4">
          <Mono>{`${picked?.name ?? ""} · ${durationMinutes} minutes`}</Mono>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {SLOTS.map((x, i) => (
            <div
              key={x}
              style={delay(i * 0.05)}
              className={`animate-z-in rounded-[10px] border py-3 text-center text-sm transition-colors duration-250 ${
                i === slot ? "border-ink bg-ink text-on-deep" : "border-line bg-surface text-ink"
              }`}
            >
              {x}
            </div>
          ))}
        </div>
        <div className="mt-[18px]">
          <Mono>Times shown in Gulf Standard Time (UTC+4)</Mono>
        </div>
        {s > 2.2 ? (
          <div className="animate-z-in mt-[18px] flex items-center gap-2">
            <span className="bg-accent-dot animate-z-pulse h-2 w-2 rounded-full" />
            <Mono sage>Securing payment…</Mono>
          </div>
        ) : null}
      </div>
    );
  } else {
    const rows: [string, string][] = [
      ["Session", picked?.name ?? ""],
      ["When", `${SLOTS[SLOT_PICK]} GST`],
      ["Where", platform],
      ["Length", `${durationMinutes} minutes`],
    ];
    pane = (
      <div>
        <div className="mb-3.5 flex items-center gap-2.5">
          <span className="bg-accent-dot text-surface flex h-[26px] w-[26px] items-center justify-center rounded-full text-sm">
            ✓
          </span>
          <div className="text-ink font-serif text-[21px] font-medium">Your session is booked</div>
        </div>
        {rows.map(([k, v], i) => (
          <div
            key={k}
            style={delay(0.15 + i * 0.08)}
            className="animate-z-in border-panel text-ink flex justify-between border-b py-[11px] text-[14.5px]"
          >
            <span>{k}</span>
            <Mono>{v}</Mono>
          </div>
        ))}
        <div className="mt-4">
          <Mono sage>Confirmed once payment is verified.</Mono>
        </div>
      </div>
    );
  }

  return (
    <div
      aria-hidden="true"
      className="flex min-w-0 flex-col gap-3.5"
      onMouseEnter={() => {
        paused.current = true;
      }}
      onMouseLeave={() => {
        paused.current = false;
      }}
    >
      <div className="bg-surface border-line-strong shadow-float overflow-hidden rounded-[14px] border">
        <div className="bg-raised border-line flex items-center justify-between border-b px-[22px] py-3.5">
          <Mono>coaching.zaaheen.com</Mono>
          <Mono>{`Step ${step + 1} of 3`}</Mono>
        </div>
        <div className="h-[340px] overflow-hidden px-6 py-[22px]">
          <div key={step} className="animate-z-fade">
            {pane}
          </div>
        </div>
      </div>
      <div className="flex justify-center gap-1.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={`h-1.5 rounded-[3px] transition-all duration-300 ${
              i === step ? "bg-ink w-[22px]" : "bg-line-strong w-1.5"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
