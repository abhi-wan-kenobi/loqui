import { useEffect, useState } from "react";

/** Wait this long before announcing a drop, so a normal connect or a blip never flashes it. */
const GRACE_MS = 1500;

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

/** Tells the user why nothing happens when the server is unreachable. */
export function ConnectionBanner({ connected, hasServer }: { connected: boolean; hasServer: boolean }) {
  const online = useOnline();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (connected || !hasServer) {
      setShow(false);
      return;
    }
    const timer = window.setTimeout(() => setShow(true), GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [connected, hasServer]);

  if (!show) return null;
  return (
    <div className="conn-banner" role="status">
      {online ? "Can't reach the server. Retrying…" : "You're offline. Reconnecting when you're back."}
    </div>
  );
}
