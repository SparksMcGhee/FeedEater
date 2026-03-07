export function subjectFor(moduleName: string, event: string): string {
  // Convention: feedeater.<module>.<event>
  // Example: feedeater.rss.messageCreated
  return `feedeater.${moduleName}.${event}`;
}

export function ingestRejectedSubjectFor(moduleName: string): string {
  return subjectFor(moduleName, "ingestRejected");
}

export function healthStatusSubjectFor(moduleName: string): string {
  return subjectFor(moduleName, "healthStatus");
}

export function isFeedeaterSubject(subject: string): boolean {
  return subject.startsWith("feedeater.");
}

export function jobSubjectFor(params: { moduleName: string; queue: string; job: string }): string {
  // Convention: feedeater.jobs.<module>.<queue>.<job>
  return `feedeater.jobs.${params.moduleName}.${params.queue}.${params.job}`;
}

export function isJobSubject(subject: string): boolean {
  return subject.startsWith("feedeater.jobs.");
}

