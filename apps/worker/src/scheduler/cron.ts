export function nextCronTime(cron: string, now: Date): Date | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const min = parts[0] ?? "";
  const hour = parts[1] ?? "";
  const dom = parts[2] ?? "";
  const mon = parts[3] ?? "";
  const dow = parts[4] ?? "";
  if (hour !== "*" || dom !== "*" || mon !== "*" || dow !== "*") return null;

  const next = new Date(now.getTime());
  next.setSeconds(0, 0);

  if (min === "*") {
    next.setMinutes(next.getMinutes() + 1);
    return next;
  }

  const stepMatch = min.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = Number(stepMatch[1]);
    if (!Number.isFinite(step) || step <= 0) return null;
    const remainder = next.getMinutes() % step;
    const add = remainder === 0 ? step : step - remainder;
    next.setMinutes(next.getMinutes() + add);
    return next;
  }

  if (/^\d+$/.test(min)) {
    const minute = Number(min);
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;
    if (next.getMinutes() < minute) {
      next.setMinutes(minute);
      return next;
    }
    next.setHours(next.getHours() + 1);
    next.setMinutes(minute);
    return next;
  }

  return null;
}
