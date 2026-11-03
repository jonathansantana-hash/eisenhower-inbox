import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);

export const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/slack-events`;

export type SlackConnection = { slack_user_id: string; team_id: string | null; updated_at: string };

export type UserSettings = {
  watch_dms: boolean;
  watch_mentions: boolean;
  watch_channel_ids: string[];
  vip_user_ids: string[];
  important_keywords: string[];
};

export const DEFAULT_SETTINGS: UserSettings = {
  watch_dms: true,
  watch_mentions: true,
  watch_channel_ids: [],
  vip_user_ids: [],
  important_keywords: [],
};

export type Quadrant ="q1" | "q2" | "q3" | "q4";
export type EiQuadrant = "ei1" | "ei2" | "ei3" | "ei4";

export type Task = {
  id: string;
  owner_id?: string;
  source: "slack" | "manual";
  slack_channel_id: string | null;
  slack_ts: string | null;
  slack_user_name: string | null;
  permalink: string | null;
  raw_text: string | null;
  title: string;
  summary: string | null;
  due_date: string | null;
  urgency: number | null;
  importance: number | null;
  effort: number | null;
  suggested_quadrant: Quadrant | null;
  suggested_ei_quadrant: EiQuadrant | null;
  ai_reason: string | null;
  quadrant: Quadrant | null;
  ei_quadrant: EiQuadrant | null;
  done: boolean;
  done_at: string | null;
  reviewed: boolean;
  moved_at: string | null;
  ei_moved_at: string | null;
  created_at: string;
};
