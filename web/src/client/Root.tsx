import { useEffect, useState } from "react";
import { AccountsPage } from "./AccountsPage";
import { App } from "./App";
import { useViewer } from "./auth";
import { Background, SignIn } from "./SignIn";

/** Signing in, then the hymn board, or the accounts at #accounts. */
export function Root() {
  const viewer = useViewer();
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);

  if (viewer === undefined) {
    return <Background />;
  }
  if (viewer === null) {
    return <SignIn />;
  }
  return hash === "#accounts" ? <AccountsPage viewer={viewer} /> : <App viewer={viewer} />;
}
