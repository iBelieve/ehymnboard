import { useEffect, useState } from "react";
import { AccountsPage } from "./AccountsPage";
import { App } from "./App";
import { useViewer } from "./auth";
import { BoardsPage } from "./BoardsPage";
import { ProfilePage } from "./ProfilePage";
import { Background, SignIn } from "./SignIn";

/**
 * Signing in, then the hymn board, every board's status at #boards, your
 * profile at #profile, or for admins, everyone's accounts at #accounts.
 */
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
  if (hash === "#boards") {
    return <BoardsPage />;
  }
  if (hash === "#profile") {
    return <ProfilePage viewer={viewer} />;
  }
  if (hash === "#accounts" && viewer.role === "admin") {
    return <AccountsPage viewer={viewer} />;
  }
  return <App viewer={viewer} />;
}
