import workerSource from "inline-worker:./worker";
import type { FitOutcome } from "./fit";
import type { FitReply, FitRequest } from "./protocol";

/**
 * Run one fit in a fresh Web Worker, made from the bundled worker source through a
 * blob URL: the plugin ships no file a worker could be started from.
 */
export function runFitInWorker(request: FitRequest): Promise<FitOutcome> {
  const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  return new Promise<FitOutcome>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(url);
    } catch (err) {
      URL.revokeObjectURL(url);
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const finish = (): void => {
      worker.terminate();
      URL.revokeObjectURL(url);
    };
    worker.onmessage = (event: MessageEvent<FitReply>) => {
      finish();
      const reply = event.data;
      if (reply.ok) resolve(reply.outcome);
      else reject(new Error(reply.error));
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "the fitting worker failed"));
    };
    worker.postMessage(request);
  });
}
