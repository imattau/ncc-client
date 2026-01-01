const HASHTAG_REGEX = /(^|\s)#([A-Za-z0-9_]+)/g;

export const extractHashtags = (text: string): string[] => {
  if (!text) return [];
  const matches = [...text.matchAll(HASHTAG_REGEX)];
  return matches.map((match) => `#${match[2]}`).filter(Boolean);
};

const URL_REGEX = /(https?:\/\/[^\s]+)/g;

export const extractUrls = (text: string): string[] => {
  if (!text) return [];
  return [...text.matchAll(URL_REGEX)].map((match) => match[1]);
};

const NOSTR_URI_REGEX = /(nostr:[^\s]+)/g;

export const extractNostrUris = (text: string): string[] => {
  if (!text) return [];
  return [...text.matchAll(NOSTR_URI_REGEX)].map((match) => match[1]);
};

export const getDomain = (url: string) => {
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch {
    return url;
  }
};
