import { Activity } from "lucide-react";

export function Sessions() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-8">
      <Activity size={32} className="text-zinc-700" strokeWidth={1.5} />
      <h2 className="text-sm font-semibold text-zinc-400">Sessions</h2>
      <p className="text-sm text-zinc-600 max-w-xs">
        Live session tracking arrives in the next phase.
      </p>
    </div>
  );
}
