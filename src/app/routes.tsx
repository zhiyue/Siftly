import { Routes, Route } from 'react-router'
import Home from './pages/Home'
import Bookmarks from './pages/Bookmarks'
import Categories from './pages/Categories'
import CategoryDetail from './pages/CategoryDetail'
import Import from './pages/Import'
import Categorize from './pages/Categorize'
import AiSearch from './pages/AiSearch'
import Mindmap from './pages/Mindmap'
import Settings from './pages/Settings'

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/bookmarks" element={<Bookmarks />} />
      <Route path="/categories" element={<Categories />} />
      <Route path="/categories/:slug" element={<CategoryDetail />} />
      <Route path="/import" element={<Import />} />
      <Route path="/categorize" element={<Categorize />} />
      <Route path="/ai-search" element={<AiSearch />} />
      <Route path="/mindmap" element={<Mindmap />} />
      <Route path="/settings" element={<Settings />} />
    </Routes>
  )
}
