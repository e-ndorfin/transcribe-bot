import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { optionalEnv } from "./env.js";

const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;

type SelectGuildIdsOptions = {
  guildIds: string[];
  guildLabels?: string[];
  prompt: string;
  allowAll?: boolean;
  overrideEnvName?: string;
};

export function configuredGuildIds(): string[] {
  const guildIds = optionalEnv("DISCORD_GUILD_IDS");
  if (guildIds) {
    return parseGuildIds(guildIds, "DISCORD_GUILD_IDS");
  }

  const guildId = optionalEnv("DISCORD_GUILD_ID");
  if (guildId) {
    return parseGuildIds(guildId, "DISCORD_GUILD_ID");
  }

  throw new Error("Missing required environment variable: DISCORD_GUILD_IDS or DISCORD_GUILD_ID.");
}

export function parseGuildIds(value: string, source: string): string[] {
  const ids = value
    .split(/[,\s]+/)
    .map((id) => id.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    throw new Error(`${source} must include at least one Discord guild ID.`);
  }

  const uniqueIds: string[] = [];
  const seen = new Set<string>();

  for (const id of ids) {
    if (!DISCORD_SNOWFLAKE_PATTERN.test(id)) {
      throw new Error(`${source} contains invalid Discord guild ID "${id}". Guild IDs should be 17-20 digits.`);
    }

    if (!seen.has(id)) {
      seen.add(id);
      uniqueIds.push(id);
    }
  }

  return uniqueIds;
}

export function configuredGuildLabels(guildIds: string[]): string[] | undefined {
  const labels = optionalEnv("DISCORD_GUILD_LABELS");
  if (!labels) {
    return undefined;
  }

  const parsedLabels = labels
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);

  if (parsedLabels.length !== guildIds.length) {
    throw new Error(
      `DISCORD_GUILD_LABELS must include exactly ${guildIds.length} comma-separated label(s), matching DISCORD_GUILD_IDS.`
    );
  }

  return parsedLabels;
}

export async function selectGuildIds(options: SelectGuildIdsOptions): Promise<string[]> {
  const { guildIds, guildLabels, prompt, allowAll = false, overrideEnvName } = options;

  if (overrideEnvName) {
    const override = optionalEnv(overrideEnvName);
    if (override) {
      const selected = resolveSelection(override, guildIds, allowAll);
      if (selected) {
        return selected;
      }

      throw new Error(
        `${overrideEnvName} must be ${allowAll ? '"all", ' : ""}one of the configured guild IDs, or a list number.`
      );
    }
  }

  if (guildIds.length === 1) {
    return guildIds;
  }

  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      `Multiple guild IDs configured. Run this command in a terminal${
        overrideEnvName ? `, or set ${overrideEnvName} to ${allowAll ? '"all" or ' : ""}one configured guild ID` : ""
      }.`
    );
  }

  output.write("\nConfigured Discord guilds:\n");
  guildIds.forEach((guildId, index) => {
    const label = guildLabels?.[index];
    output.write(`  ${index + 1}. ${label ? `${label} (${guildId})` : guildId}\n`);
  });
  if (allowAll) {
    output.write("  a. all guilds\n");
  }

  const rl = createInterface({ input, output });
  try {
    while (true) {
      const answer = await rl.question(`${prompt}: `);
      const selected = resolveSelection(answer, guildIds, allowAll);
      if (selected) {
        return selected;
      }

      output.write("Please enter a listed number");
      if (allowAll) {
        output.write(', "a", or "all"');
      }
      output.write(".\n");
    }
  } finally {
    rl.close();
  }
}

function resolveSelection(answer: string, guildIds: string[], allowAll: boolean): string[] | undefined {
  const trimmed = answer.trim();
  const normalized = trimmed.toLowerCase();

  if (!trimmed) {
    return undefined;
  }

  if (allowAll && (normalized === "a" || normalized === "all" || normalized === "*")) {
    return guildIds;
  }

  const selectedIndex = Number(trimmed);
  if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= guildIds.length) {
    return [guildIds[selectedIndex - 1]];
  }

  if (guildIds.includes(trimmed)) {
    return [trimmed];
  }

  return undefined;
}
