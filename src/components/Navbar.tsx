import React, { useState } from 'react';
import {
  Search,
  ShoppingCart,
  Home,
  Calendar,
  Ticket as TicketIcon,
  User,
  ShieldAlert,
  Menu,
  X,
} from 'lucide-react';
import { BrandLogo } from './BrandLogo';

export type AppView =
  | 'home'
  | 'events'
  | 'event-detail'
  | 'checkout'
  | 'client-area'
  | 'admin'
  | 'about'
  | 'contact';

export type ClientSubTab = 'tickets' | 'orders' | 'login' | 'register' | 'recover';

interface NavbarProps {
  activeView: AppView;
  onNavigate: (view: AppView, subTab?: ClientSubTab) => void;
  cartCount: number;
  searchQuery: string;
  onSearchChange: (q: string) => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeView,
  onNavigate,
  cartCount,
  searchQuery,
  onSearchChange,
}) => {
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navItems: { id: AppView; label: string; subTab?: ClientSubTab }[] = [
    { id: 'home', label: 'Início' },
    { id: 'events', label: 'Eventos' },
    { id: 'client-area', label: 'Meus Ingressos', subTab: 'tickets' },
    { id: 'about', label: 'Sobre' },
    { id: 'contact', label: 'Contato' },
  ];

  return (
    <>
      <header className="sticky top-0 z-40 bg-[#070709]/95 backdrop-blur-md border-b border-[#1D1F29]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 sm:h-20 flex items-center justify-between gap-4 sm:gap-8">
          {/* Zone 1: Official PX CUSTON Brand Logo */}
          <button
            type="button"
            onClick={() => onNavigate('home')}
            className="flex items-center shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#E50914] rounded-md"
            aria-label="Ir para a página inicial da PX CUSTON"
          >
            <BrandLogo size="md" />
          </button>

          {/* Zone 2: Primary Desktop Navigation Links */}
          <nav
            aria-label="Navegação Principal"
            className="hidden lg:flex items-center gap-7 text-sm font-medium"
          >
            {navItems.map((item) => {
              const isActive =
                activeView === item.id ||
                (item.id === 'events' && activeView === 'event-detail');
              return (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => onNavigate(item.id, item.subTab)}
                  className={`relative py-2 transition-colors whitespace-nowrap shrink-0 ${
                    isActive ? 'text-white font-semibold' : 'text-neutral-400 hover:text-white'
                  }`}
                >
                  {item.label}
                  {isActive && (
                    <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#E50914] rounded-full" />
                  )}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => onNavigate('admin')}
              className={`relative py-2 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                activeView === 'admin'
                  ? 'text-[#E50914] font-semibold'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              <ShieldAlert className="w-4 h-4 text-[#E50914]" />
              <span>PX CONTROL</span>
              {activeView === 'admin' && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#E50914] rounded-full" />
              )}
            </button>
          </nav>

          {/* Zone 3: Search, Entrar Button, and Cart Trigger */}
          <div className="flex items-center gap-2.5 sm:gap-3 shrink-0">
            {searchOpen ? (
              <div className="relative flex items-center">
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => {
                    onSearchChange(e.target.value);
                    if (activeView !== 'home' && activeView !== 'events') {
                      onNavigate('events');
                    }
                  }}
                  placeholder="Buscar evento ou cidade..."
                  aria-label="Buscar evento ou cidade"
                  className="w-44 sm:w-56 h-10 pl-3.5 pr-9 rounded-lg bg-[#12131A] border border-[#2A2D3A] text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-[#E50914]"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => {
                    setSearchOpen(false);
                    onSearchChange('');
                  }}
                  aria-label="Fechar busca"
                  className="absolute right-2.5 text-neutral-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                aria-label="Abrir busca de eventos"
                className="min-w-[40px] min-h-[40px] rounded-full bg-[#13151C] border border-[#242733] flex items-center justify-center text-neutral-300 hover:text-white hover:border-[#E50914] transition-colors"
              >
                <Search className="w-4 h-4" />
              </button>
            )}

            <button
              type="button"
              onClick={() => onNavigate('client-area', 'login')}
              className="px-4 sm:px-5 py-2 min-h-[40px] rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white text-xs sm:text-sm font-semibold tracking-wide transition-colors whitespace-nowrap shrink-0 shadow-[0_0_20px_rgba(229,9,20,0.3)]"
            >
              Entrar
            </button>

            <button
              type="button"
              onClick={() => onNavigate('checkout')}
              aria-label={`Carrinho de ingressos com ${cartCount} itens`}
              className="relative min-w-[40px] min-h-[40px] rounded-full bg-[#13151C] border border-[#242733] flex items-center justify-center text-neutral-200 hover:text-white hover:border-[#E50914] transition-colors"
            >
              <ShoppingCart className="w-4 h-4" />
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-[#E50914] text-[10px] font-bold text-white flex items-center justify-center font-mono-tabular">
                {cartCount}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label={mobileMenuOpen ? 'Fechar menu' : 'Abrir menu de navegação'}
              className="lg:hidden min-w-[40px] min-h-[40px] rounded-lg bg-[#13151C] border border-[#242733] flex items-center justify-center text-neutral-200 hover:text-white"
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {/* Mobile Drawer Menu */}
        {mobileMenuOpen && (
          <div className="lg:hidden bg-[#0D0E13] border-b border-[#222530] px-4 pt-3 pb-5 space-y-2">
            {navItems.map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => {
                  onNavigate(item.id, item.subTab);
                  setMobileMenuOpen(false);
                }}
                className="w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium text-neutral-200 hover:bg-[#171922] hover:text-white flex items-center justify-between"
              >
                <span>{item.label}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                onNavigate('admin');
                setMobileMenuOpen(false);
              }}
              className="w-full text-left px-3 py-2.5 rounded-lg text-sm font-semibold text-[#E50914] bg-[#E50914]/10 border border-[#E50914]/30 flex items-center gap-2"
            >
              <ShieldAlert className="w-4 h-4" />
              <span>Painel Administrativo — PX CONTROL</span>
            </button>
          </div>
        )}
      </header>

      {/* Mobile Bottom Navigation Bar (Matches mobile reference mockup: Início, Eventos, Ingressos, Perfil) */}
      <nav
        aria-label="Navegação Inferior Mobile"
        className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#0A0B0E]/95 backdrop-blur-md border-t border-[#1F222D] grid grid-cols-5 items-center h-14 px-1"
      >
        <button
          type="button"
          onClick={() => onNavigate('home')}
          className={`flex flex-col items-center justify-center min-h-[44px] ${
            activeView === 'home' ? 'text-[#E50914]' : 'text-neutral-400 hover:text-white'
          }`}
        >
          <Home className="w-4 h-4" />
          <span className="text-[10px] font-medium mt-0.5 whitespace-nowrap">Início</span>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('events')}
          className={`flex flex-col items-center justify-center min-h-[44px] ${
            activeView === 'events' || activeView === 'event-detail'
              ? 'text-[#E50914]'
              : 'text-neutral-400 hover:text-white'
          }`}
        >
          <Calendar className="w-4 h-4" />
          <span className="text-[10px] font-medium mt-0.5 whitespace-nowrap">Eventos</span>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('client-area', 'tickets')}
          className={`flex flex-col items-center justify-center min-h-[44px] ${
            activeView === 'client-area' ? 'text-[#E50914]' : 'text-neutral-400 hover:text-white'
          }`}
        >
          <TicketIcon className="w-4 h-4" />
          <span className="text-[10px] font-medium mt-0.5 whitespace-nowrap">Ingressos</span>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('client-area', 'orders')}
          className="flex flex-col items-center justify-center min-h-[44px] text-neutral-400 hover:text-white"
        >
          <User className="w-4 h-4" />
          <span className="text-[10px] font-medium mt-0.5 whitespace-nowrap">Perfil</span>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('admin')}
          className={`flex flex-col items-center justify-center min-h-[44px] ${
            activeView === 'admin' ? 'text-[#E50914]' : 'text-neutral-400 hover:text-white'
          }`}
        >
          <ShieldAlert className="w-4 h-4" />
          <span className="text-[10px] font-medium mt-0.5 whitespace-nowrap">PX Control</span>
        </button>
      </nav>
    </>
  );
};
