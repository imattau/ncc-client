export type SearchEntryType = "event" | "profile";

export interface SearchEntry {
  id: string;
  type: SearchEntryType;
  label: string;
  description?: string;
  meta?: string;
  link: string;
}
