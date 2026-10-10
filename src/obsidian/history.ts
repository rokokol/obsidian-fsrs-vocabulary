import type { DataAdapter } from "obsidian";
import {
  entryKey,
  formatEntry,
  historyFileName,
  isHistoryFile,
  parseHistory,
  type DevicePlatform,
  type ReviewLogEntry,
} from "../model/history";

/** The part of the vault adapter the review log needs. */
export type HistoryAdapter = Pick<DataAdapter, "exists" | "read" | "write" | "append" | "list">;

/** Every review read back from the log. */
export interface HistoryRead {
  /** Oldest first, each review once however many files hold it. */
  entries: ReviewLogEntry[];
  /** Log files read, counting every device and any conflict copy. */
  files: number;
}

/**
 * The review log kept in the plugin's folder: this device appends to its own file,
 * and reading takes every device's file together.
 */
export class ReviewHistory {
  /** Appends run one at a time, so lines land in the order they were graded. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: HistoryAdapter,
    private readonly dir: string,
    private readonly platform: DevicePlatform,
    private readonly deviceId: string,
  ) {}

  /** Path of the file this device writes. */
  get path(): string {
    return `${this.dir}/${historyFileName(this.platform, this.deviceId)}`;
  }

  /** Add one review to this device's file. */
  append(entry: ReviewLogEntry): Promise<void> {
    const line = formatEntry(entry);
    const run = async (): Promise<void> => {
      // Created with `write` rather than left to `append`: whether `append` creates
      // a missing file is up to each platform's adapter, and the API does not say.
      if (await this.adapter.exists(this.path)) await this.adapter.append(this.path, line);
      else await this.adapter.write(this.path, line);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Every review from every device, oldest first. */
  async readAll(): Promise<HistoryRead> {
    if (!(await this.adapter.exists(this.dir))) return { entries: [], files: 0 };
    const listed = await this.adapter.list(this.dir);
    const paths = listed.files.filter((path) =>
      isHistoryFile(path.slice(path.lastIndexOf("/") + 1)),
    );
    const seen = new Set<string>();
    const entries: ReviewLogEntry[] = [];
    let files = 0;
    for (const path of paths) {
      let text: string;
      try {
        text = await this.adapter.read(path);
      } catch (err) {
        // One unreadable file — mid-sync, say — leaves the others usable.
        console.warn(`[fsrs-vocabulary] could not read ${path}`, err);
        continue;
      }
      files += 1;
      for (const entry of parseHistory(text)) {
        const key = entryKey(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(entry);
      }
    }
    entries.sort((a, b) => a.t - b.t);
    return { entries, files };
  }
}
