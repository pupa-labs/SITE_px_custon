import React from 'react';
import { ShieldCheck, Lock, QrCode, Smartphone } from 'lucide-react';
import { BrandLogo } from './BrandLogo';
import type { AppView, ClientSubTab } from './Navbar';

interface FooterProps {
  onNavigate: (view: AppView, subTab?: ClientSubTab) => void;
}

export const Footer: React.FC<FooterProps> = ({ onNavigate }) => {
  return (
    <footer className="bg-[#050507] border-t border-[#1A1C26] text-neutral-400 pb-20 lg:pb-10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 space-y-10">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-8">
          {/* Brand Column */}
          <div className="lg:col-span-4 space-y-4">
            <BrandLogo size="lg" />
            <p className="text-xs sm:text-sm text-neutral-400 leading-relaxed max-w-sm">
              Plataforma oficial da PX CUSTON para organização de encontros automotivos, exposições
              de carros rebaixados, motos, eventos de performance e check-in online via QR Code.
            </p>
          </div>

          {/* Navigation Links */}
          <div className="lg:col-span-3 space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-white">Plataforma</h3>
            <ul className="space-y-2 text-xs">
              <li>
                <button
                  type="button"
                  onClick={() => onNavigate('home')}
                  className="hover:text-white transition-colors"
                >
                  Página Inicial
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onNavigate('events')}
                  className="hover:text-white transition-colors"
                >
                  Calendário de Eventos
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onNavigate('client-area', 'tickets')}
                  className="hover:text-white transition-colors"
                >
                  Meus Ingressos QR Code
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onNavigate('client-area', 'orders')}
                  className="hover:text-white transition-colors"
                >
                  Meus Pedidos
                </button>
              </li>
            </ul>
          </div>

          {/* Customer & Admin Area */}
          <div className="lg:col-span-2 space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-white">Acesso</h3>
            <ul className="space-y-2 text-xs">
              <li>
                <button
                  type="button"
                  onClick={() => onNavigate('client-area', 'login')}
                  className="hover:text-white transition-colors"
                >
                  Login do Cliente
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onNavigate('client-area', 'register')}
                  className="hover:text-white transition-colors"
                >
                  Criar Cadastro
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onNavigate('admin')}
                  className="text-[#E50914] font-semibold hover:underline"
                >
                  PX CONTROL (Admin)
                </button>
              </li>
            </ul>
          </div>

          {/* Architecture & Security Trust */}
          <div className="lg:col-span-3 space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-white">
              Segurança & Tecnologia
            </h3>
            <div className="space-y-2 text-xs text-neutral-400">
              <p className="flex items-center gap-2">
                <Lock className="w-3.5 h-3.5 text-[#E50914] shrink-0" />
                <span>Pagamentos oficiais via Mercado Pago</span>
              </p>
              <p className="flex items-center gap-2">
                <ShieldCheck className="w-3.5 h-3.5 text-[#E50914] shrink-0" />
                <span>Persistência Supabase PostgreSQL + RLS</span>
              </p>
              <p className="flex items-center gap-2">
                <QrCode className="w-3.5 h-3.5 text-[#E50914] shrink-0" />
                <span>Validação única anti-fraude na portaria</span>
              </p>
              <p className="flex items-center gap-2">
                <Smartphone className="w-3.5 h-3.5 text-[#E50914] shrink-0" />
                <span>Aplicação Web Progressiva (PWA)</span>
              </p>
            </div>
          </div>
        </div>

        <div className="pt-6 border-t border-[#151720] flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-neutral-500">
          <p>© {new Date().getFullYear()} PX CUSTON — Eventos, Carros e Experiências. Todos os direitos reservados.</p>
          <p>Eventos administrados exclusivamente pela equipe oficial autorizada PX CUSTON.</p>
        </div>
      </div>
    </footer>
  );
};
