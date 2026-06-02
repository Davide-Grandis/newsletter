import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, ApiError, Help as HelpDoc } from '../api';

export default function Help() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['help'],
    queryFn: () => api<HelpDoc>('/api/help'),
    retry: false,
  });

  if (isLoading) {
    return <div className="text-sm text-slate-500 dark:text-slate-400">Loading…</div>;
  }

  if (error) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">Help</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {notFound
            ? 'No help document has been uploaded yet.'
            : (error as Error).message}
        </p>
        <p className="text-xs text-slate-400 dark:text-slate-500">
          Upload one with:{' '}
          <code className="bg-slate-100 px-1 rounded dark:bg-slate-800">
            wrangler r2 object put newsletter-admin/help.md --jurisdiction eu --file ./README.md --content-type text/markdown
          </code>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">Help</h1>
        {data?.updated && (
          <span className="text-xs text-slate-400 dark:text-slate-500">
            updated {new Date(data.updated).toLocaleString()}
          </span>
        )}
      </div>
      <article className="prose-sm max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
          {data?.content ?? ''}
        </ReactMarkdown>
      </article>
    </div>
  );
}

// Minimal Tailwind styling for the rendered markdown (no @tailwindcss/typography
// plugin installed, so map the common elements explicitly).
const mdComponents = {
  h1: (p: any) => <h1 className="text-2xl font-semibold mt-6 mb-3" {...p} />,
  h2: (p: any) => <h2 className="text-xl font-semibold mt-6 mb-2 border-b border-slate-200 dark:border-slate-800 pb-1" {...p} />,
  h3: (p: any) => <h3 className="text-lg font-medium mt-4 mb-2" {...p} />,
  p: (p: any) => <p className="my-3 leading-relaxed text-slate-700 dark:text-slate-300" {...p} />,
  ul: (p: any) => <ul className="list-disc pl-6 my-3 space-y-1 text-slate-700 dark:text-slate-300" {...p} />,
  ol: (p: any) => <ol className="list-decimal pl-6 my-3 space-y-1 text-slate-700 dark:text-slate-300" {...p} />,
  li: (p: any) => <li className="leading-relaxed" {...p} />,
  a: (p: any) => <a className="text-blue-600 hover:underline dark:text-blue-400" {...p} />,
  code: (p: any) =>
    p.inline ? (
      <code className="bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded text-[0.85em] font-mono" {...p} />
    ) : (
      <code className="font-mono text-sm" {...p} />
    ),
  pre: (p: any) => (
    <pre className="bg-slate-100 dark:bg-slate-800 rounded p-3 my-3 overflow-x-auto text-sm" {...p} />
  ),
  blockquote: (p: any) => (
    <blockquote className="border-l-4 border-slate-300 dark:border-slate-700 pl-4 my-3 text-slate-600 dark:text-slate-400" {...p} />
  ),
  table: (p: any) => (
    <div className="overflow-x-auto my-3">
      <table className="w-full text-sm border border-slate-200 dark:border-slate-800" {...p} />
    </div>
  ),
  th: (p: any) => <th className="text-left p-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800" {...p} />,
  td: (p: any) => <td className="p-2 border border-slate-200 dark:border-slate-800" {...p} />,
  hr: () => <hr className="my-6 border-slate-200 dark:border-slate-800" />,
};
