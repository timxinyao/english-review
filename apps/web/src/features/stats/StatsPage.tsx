import { Link } from 'react-router-dom';

export function StatsPage() {
  return (
    <section className="space-y-2">
      <h1 className="text-lg font-semibold">Stats</h1>
      <p className="text-sm text-muted-foreground">统计与热力图将在 Phase 6 上线。</p>
      <Link to="/settings" className="text-sm text-accent hover:underline">
        返回设置
      </Link>
    </section>
  );
}
