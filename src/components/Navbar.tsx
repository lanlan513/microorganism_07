import { Link, useLocation } from 'react-router-dom';
import { Home, Dna, Search, Menu, X, Palette, ShieldCheck } from 'lucide-react';
import { useState, useEffect } from 'react';

export function Navbar() {
  const location = useLocation();
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const navItems = [
    { to: '/', label: '首页大厅', icon: Home },
    { to: '/category/bacteria', label: '细菌', icon: Dna },
    { to: '/category/fungi', label: '真菌', icon: Dna },
    { to: '/category/virus', label: '病毒', icon: Dna },
    { to: '/category/archaea', label: '古菌', icon: Dna },
    { to: '/corridor', label: '讲解走廊', icon: Palette },
    { to: '/moderation', label: '审核台', icon: ShieldCheck },
  ];

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-500 ${
        scrolled
          ? 'bg-background-deep/80 backdrop-blur-xl border-b border-glow-primary/10 py-3'
          : 'bg-transparent py-5'
      }`}
    >
      <div className="container mx-auto px-6 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-3 group">
          <div className="relative">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-glow-primary/20 to-glow-purple/20 flex items-center justify-center border border-glow-primary/40 group-hover:shadow-glow transition-shadow">
              <Dna className="w-5 h-5 text-glow-primary" />
            </div>
            <div className="absolute inset-0 rounded-full bg-glow-primary/20 blur-lg opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          <div>
            <h1 className="font-display text-xl font-semibold text-text-light tracking-wide">
              微生物文明馆
            </h1>
            <p className="font-mono text-[10px] text-text-muted tracking-[0.2em] uppercase">
              Microbial Civilization
            </p>
          </div>
        </Link>

        <div className="hidden lg:flex items-center gap-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive =
              item.to === '/'
                ? location.pathname === '/'
                : location.pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`relative px-5 py-2.5 rounded-full font-mono text-sm transition-all duration-300 ${
                  isActive
                    ? 'text-glow-primary bg-glow-primary/10'
                    : 'text-text-muted hover:text-text-light hover:bg-white/5'
                }`}
              >
                <span className="flex items-center gap-2">
                  <Icon className="w-4 h-4" />
                  {item.label}
                </span>
                {isActive && (
                  <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-glow-primary" />
                )}
              </Link>
            );
          })}
        </div>

        <div className="flex items-center gap-3">
          <button className="hidden sm:flex items-center gap-2 px-4 py-2 rounded-full border border-glow-primary/20 text-text-muted hover:text-glow-primary hover:border-glow-primary/40 transition-all text-sm font-mono">
            <Search className="w-4 h-4" />
            <span>搜索标本</span>
          </button>
          <button
            className="lg:hidden p-2 rounded-lg border border-glow-primary/20 text-text-light"
            onClick={() => setMobileOpen(!mobileOpen)}
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div className="lg:hidden mt-4 mx-6 glass-card p-4 animate-fade-in-up">
          <div className="flex flex-col gap-2">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive =
                item.to === '/'
                  ? location.pathname === '/'
                  : location.pathname.startsWith(item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={() => setMobileOpen(false)}
                  className={`px-4 py-3 rounded-xl font-mono text-sm flex items-center gap-3 ${
                    isActive
                      ? 'text-glow-primary bg-glow-primary/10'
                      : 'text-text-muted hover:text-text-light hover:bg-white/5'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </nav>
  );
}
