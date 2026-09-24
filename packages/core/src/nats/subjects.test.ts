import { describe, expect, it } from "vitest";
import { isFeedeaterSubject, isJobSubject, jobSubjectFor, subjectFor } from "./subjects";

describe("subject grammar", () => {
  it("builds event subjects as feedeater.<module>.<event>", () => {
    expect(subjectFor("slack", "messageCreated")).toBe("feedeater.slack.messageCreated");
    expect(subjectFor("example", "narrativeUpdated")).toBe("feedeater.example.narrativeUpdated");
  });

  it("builds job subjects as feedeater.jobs.<module>.<queue>.<job>", () => {
    expect(jobSubjectFor({ moduleName: "slack", queue: "mod_slack", job: "collect" })).toBe(
      "feedeater.jobs.slack.mod_slack.collect",
    );
  });

  it("treats job subjects as feedeater subjects", () => {
    const s = jobSubjectFor({ moduleName: "example", queue: "q", job: "tick" });
    expect(isJobSubject(s)).toBe(true);
    expect(isFeedeaterSubject(s)).toBe(true);
  });

  it("classifies non-job and foreign subjects correctly", () => {
    expect(isJobSubject("feedeater.slack.messageCreated")).toBe(false);
    expect(isFeedeaterSubject("somebody.elses.subject")).toBe(false);
  });
});
