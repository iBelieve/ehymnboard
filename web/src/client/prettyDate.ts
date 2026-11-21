/** "just now", "5 minutes ago", "on 20 Nov 26", like the Flask admin. */
export function prettyDate(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const diffMs = now.getTime() - date.getTime();
  const days = Math.floor(diffMs / 86_400_000);
  const seconds = Math.floor((diffMs % 86_400_000) / 1000);

  if (days > 7 || days < 0) {
    const month = date.toLocaleString("en-US", { month: "short" });
    const day = String(date.getDate()).padStart(2, "0");
    return `on ${day} ${month} ${String(date.getFullYear()).slice(2)}`;
  }
  if (days === 1) return "1 day ago";
  if (days > 1) return `${days} days ago`;
  if (seconds < 60) return "just now";
  if (seconds < 120) return "1 minute ago";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 7200) return "1 hour ago";
  return `${Math.floor(seconds / 3600)} hours ago`;
}
