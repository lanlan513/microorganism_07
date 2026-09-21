import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { Navbar } from './components/Navbar';
import { Footer } from './components/Footer';
import { ParticleBackground } from './components/ParticleBackground';
import { HomePage } from './pages/HomePage';
import { CategoryPage } from './pages/CategoryPage';
import { DetailPage } from './pages/DetailPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { GalleryPage } from './annotations/GalleryPage';
import { StudioPage } from './annotations/StudioPage';
import { CardDetailPage } from './annotations/CardDetailPage';

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
            <Route path="/gallery" element={<GalleryPage />} />
            <Route path="/studio/:specimenId" element={<StudioPage />} />
            <Route path="/studio/card/:cardId" element={<StudioPage />} />
            <Route path="/cards/:cardId" element={<CardDetailPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>
        <Footer />
      </div>
    </Router>
  );
}
