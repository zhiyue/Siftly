import { useState, useEffect } from 'react'
import { Link } from 'react-router'
import { BookmarkIcon, Tag, Image, Layers, Upload, Sparkles, Search, ArrowRight, TrendingUp, Bookmark } from 'lucide-react'
import BookmarkCard from '../components/bookmark-card'
import type { BookmarkWithMedia } from '@/lib/types'

interface DashboardData {
  totalBookmarks: number
  bookmarkSourceCount: number
  likeSourceCount: number
  totalCategories: number
  totalMedia: number
  uncategorizedCount: number
  recentBookmarks: BookmarkWithMedia[]
  topCategories: { name: string; slug: string; color: string; count: number }[]
}

const EMPTY_DASHBOARD: DashboardData = {
  totalBookmarks: 0,
  bookmarkSourceCount: 0,
  likeSourceCount: 0,
  totalCategories: 0,
  totalMedia: 0,
  uncategorizedCount: 0,
  recentBookmarks: [],
  topCategories: [],
}

function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

function formatDate(): string {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

interface StatCardProps {
  label: string
  value: number
  icon: React.ComponentType<{ size?: number; className?: string }>
  iconColor: string
  iconBg: string
  borderColor: string
  trend?: string
  href?: string
}

function StatCard({ label, value, icon: Icon, iconColor, iconBg, borderColor, trend, href }: StatCardProps) {
  const inner = (
    <>
      <div className="flex items-start justify-between mb-3">
        <div className={`p-2.5 rounded-xl ${iconBg}`}>
          <Icon size={18} className={iconColor} />
        </div>
        {trend && (
          <span className="text-xs text-zinc-500 flex items-center gap-1">
            <TrendingUp size={11} />
            {trend}
          </span>
        )}
      </div>
      <p className="text-3xl font-bold text-zinc-100 mb-1 tracking-tight">{value.toLocaleString()}</p>
      <p className="text-sm text-zinc-500">{label}</p>
    </>
  )
  const cls = `bg-zinc-900 border border-zinc-800 rounded-2xl p-5 hover:border-zinc-700 transition-all duration-200 relative overflow-hidden border-t-2 ${borderColor} ${href ? 'cursor-pointer hover:bg-zinc-800/60' : ''}`
  if (href) {
    return <Link to={href} className={cls}>{inner}</Link>
  }
  return <div className={cls}>{inner}</div>
}

function EmptyState() {
  return (
    <div className="p-6 md:p-8 min-h-screen flex items-center justify-center">
      <div className="text-center max-w-md mx-auto">
        <div className="flex items-center justify-center w-20 h-20 rounded-3xl bg-indigo-500/10 mx-auto mb-6">
          <BookmarkIcon size={36} className="text-indigo-400 opacity-80" />
        </div>
        <h2 className="text-2xl font-bold text-zinc-100 mb-3">No bookmarks yet</h2>
        <p className="text-zinc-400 mb-8 leading-relaxed">
          Import your Twitter bookmarks to get started. Once imported, use AI to automatically
          categorize and organize them.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            to="/import"
            className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm transition-colors"
          >
            <Upload size={16} />
            Import bookmarks
          </Link>
          <Link
            to="/settings"
            className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium text-sm transition-colors border border-zinc-700"
          >
            Configure settings
          </Link>
        </div>
      </div>
    </div>
  )
}

export default function Home() {
  const [data, setData] = useState<DashboardData>(EMPTY_DASHBOARD)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/stats')
      .then((r) => r.json() as Promise<DashboardData>)
      .then((d) => setData({
        totalBookmarks: d.totalBookmarks ?? 0,
        bookmarkSourceCount: d.bookmarkSourceCount ?? 0,
        likeSourceCount: d.likeSourceCount ?? 0,
        totalCategories: d.totalCategories ?? 0,
        totalMedia: d.totalMedia ?? 0,
        uncategorizedCount: d.uncategorizedCount ?? 0,
        recentBookmarks: d.recentBookmarks ?? [],
        topCategories: d.topCategories ?? [],
      }))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="p-6 md:p-8 max-w-7xl mx-auto space-y-8">
        <div className="h-10 w-64 bg-zinc-800 rounded animate-pulse" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-32 bg-zinc-900 border border-zinc-800 rounded-2xl animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  if (data.totalBookmarks === 0) {
    return <EmptyState />
  }

  const categorizedCount = data.totalBookmarks - data.uncategorizedCount

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto space-y-8">

      {/* Hero Section */}
      <div>
        <p className="text-sm text-zinc-500 mb-1 uppercase tracking-widest font-medium">{formatDate()}</p>
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-zinc-100">
              {getGreeting()} <span className="text-indigo-400">&#128075;</span>
            </h1>
            <p className="text-zinc-400 mt-1.5">
              You have{' '}
              <span className="text-zinc-100 font-semibold">{data.totalBookmarks.toLocaleString()}</span>{' '}
              tweets saved and ready to explore.
              {data.likeSourceCount > 0 && (
                <span className="text-zinc-500">
                  {' '}({data.bookmarkSourceCount.toLocaleString()} bookmarks, {data.likeSourceCount.toLocaleString()} likes)
                </span>
              )}
            </p>
          </div>
          {/* Quick Actions */}
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              to="/import"
              className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl transition-colors"
            >
              <Upload size={15} />
              Import More
            </Link>
            <Link
              to="/categorize"
              className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl transition-colors border border-zinc-700"
            >
              <Sparkles size={15} />
              AI Categorize
            </Link>
            <Link
              to="/ai-search"
              className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-xl transition-colors"
            >
              <Search size={15} />
              AI Search
            </Link>
          </div>
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label={data.likeSourceCount > 0 ? `${data.bookmarkSourceCount.toLocaleString()} bookmarks \u00B7 ${data.likeSourceCount.toLocaleString()} likes` : 'Total Bookmarks'}
          value={data.totalBookmarks}
          icon={BookmarkIcon}
          iconColor="text-indigo-400"
          iconBg="bg-indigo-500/10"
          borderColor="border-t-indigo-500"
        />
        <StatCard
          label="Categorized"
          value={categorizedCount}
          icon={Tag}
          iconColor="text-emerald-400"
          iconBg="bg-emerald-500/10"
          borderColor="border-t-emerald-500"
        />
        <StatCard
          label="Media Items"
          value={data.totalMedia}
          icon={Image}
          iconColor="text-violet-400"
          iconBg="bg-violet-500/10"
          borderColor="border-t-violet-500"
        />
        <StatCard
          label="Uncategorized"
          value={data.uncategorizedCount}
          icon={Layers}
          iconColor="text-amber-400"
          iconBg="bg-amber-500/10"
          borderColor="border-t-amber-500"
          href="/bookmarks?uncategorized=true"
        />
      </div>

      {/* Recently Added */}
      {data.recentBookmarks.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-5">
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-widest font-medium mb-0.5">Latest</p>
              <h2 className="text-xl font-semibold text-zinc-100">Recently Added</h2>
            </div>
            <Link
              to="/bookmarks"
              className="flex items-center gap-1.5 text-sm text-indigo-400 hover:text-indigo-300 transition-colors font-medium"
            >
              View all
              <ArrowRight size={14} />
            </Link>
          </div>
          <div className="masonry-grid">
            {data.recentBookmarks.map((bookmark) => (
              <div key={bookmark.id} className="masonry-item">
                <BookmarkCard bookmark={bookmark} />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Top Categories */}
      {data.topCategories.length > 0 && (
        <section className="pb-8">
          <div className="flex items-center justify-between mb-5">
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-widest font-medium mb-0.5">Browse by topic</p>
              <h2 className="text-xl font-semibold text-zinc-100">Top Categories</h2>
            </div>
            <Link
              to="/categories"
              className="flex items-center gap-1.5 text-sm text-indigo-400 hover:text-indigo-300 transition-colors font-medium"
            >
              Manage
              <ArrowRight size={14} />
            </Link>
          </div>
          <div className="flex gap-2 flex-wrap">
            {data.topCategories.map((cat) => (
              <Link
                key={cat.slug}
                to={`/categories/${cat.slug}`}
                className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-600 hover:bg-zinc-800/80 transition-all duration-200 text-sm group"
              >
                <Bookmark
                  size={13}
                  className="shrink-0 transition-colors"
                  style={{ color: cat.color, fill: cat.color }}
                />
                <span className="text-zinc-300 group-hover:text-zinc-100 transition-colors font-medium">{cat.name}</span>
                <span className="text-zinc-500 text-xs tabular-nums">
                  {cat.count}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
