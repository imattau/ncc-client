import { DEFAULT_RELAYS } from "../config/relays";

export async function listRelays() {
  return DEFAULT_RELAYS;
}

export async function preferredRelays() {
  return DEFAULT_RELAYS;
}

export default {
  listRelays,
  preferredRelays
};
