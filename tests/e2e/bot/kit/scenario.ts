import type { BotLab } from "./bots";
import type { E2eConfig } from "./config";
import type { ScenarioRecorder } from "./report";
import type { ModelChoice, Session } from "./session";

export type ScenarioContext = {
  lab: BotLab;
  session: Session;
  config: E2eConfig;
  model: ModelChoice;
  rec: ScenarioRecorder;
};

export type Scenario = {
  id: string;
  title: string;
  /** One sentence: what a green run of this scenario proves. */
  summary: string;
  run(context: ScenarioContext): Promise<void>;
};
