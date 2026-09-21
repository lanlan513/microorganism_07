import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { Navbar } from './components/Navbar';
import { Footer } from './components/Footer';
import { ParticleBackground } from './components/ParticleBackground';
import { HomePage } from './pages/HomePage';
import { CategoryPage } from './pages/CategoryPage';
import { DetailPage } from './pages/DetailPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { StudioPage } from './pages/StudioPage';
import { CorridorPage } from './pages/CorridorPage';
import { CardViewPage } from './pages/CardViewPage';
import { ModerationPage } from './pages/ModerationPage';

export default function App() {
  return (
    <Router>
      <div className="relative min-h-screen flex flex-col">
        <ParticleBackground />
        <Navbar />
        <main className="relative z-10 flex-1">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/category/:category" element={<CategoryPage />} />
            <Route path="/microbe/:id" element={<DetailPage />} />
            {/* 显微镜视野涂鸦共享馆 */}
            <Route path="/corridor" element={<CorridorPage />} />
            <Route path="/corridor/:specimenId" element={<CorridorPage />} />
            <Route path="/cards/:id" element={<CardViewPage />} />
            <Route path="/studio/:specimenId" element={<StudioPage />} />
            <Route path="/studio/:specimenId/:cardId" element={<StudioPage />} />
            <Route path="/moderation" element={<ModerationPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>
        <Footer />
      </div>
    </Router>
  );
}
