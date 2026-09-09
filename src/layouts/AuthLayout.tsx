import LanguageSwitcher from '../components/LanguageSwitcher';
import { getWLBrandShort } from '../lib/wl-brand';
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import apiClient from '../lib/api';
import {
  Home, MessageSquare, Users, Palette, Star,
  BarChart3, Settings, Bell,
  Shield, LogOut,
  Zap, UserPlus, MapPin, Bot,
  FileText, Clock, Moon, Sun, Menu, X, Mail,
  Workflow, Link, GraduationCap, MessageCircle, FormInput, PenTool,
  CreditCard, Building2, PhoneOff, Camera, Upload, Store,
  Globe, QrCode, Search, Key, FileCheck, ExternalLink
} from 'lucide-react';
import { useAuthStore } from '../lib/authStore';
import { useThemeStore } from '../lib/themeStore';
import { MobileApp } from '../lib/capacitor-app';
import { useDesignVariant } from '../contexts/DesignVariantContext';
import { useViewport } from '../hooks/useViewport';
import NotificationCenter from '../components/NotificationCenter';
import AvaExecutiveAssistant from '../components/AvaExecutiveAssistant';

interface MenuItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  badge?: number;
  roles?: string[];
  isExternal?: boolean;
}

// â”€â”€ Primary navigation (clean, grouped, no duplicates) â”€â”€
const menuItems: MenuItem[] = [
  { id: '/dashboard', label: 'Dashboard', icon: <Home size={20} /> },
  { id: '/whatsapp', label: 'WhatsApp', icon: <MessageSquare size={20} />, badge: 6 },
  { id: '/crm', label: 'CRM & Leads', icon: <Users size={20} /> },
  { id: '/leads', label: 'Lead Generation', icon: <UserPlus size={20} /> },
  { id: '/ecommerce', label: 'E-Commerce', icon: <Store size={20} /> },
  { id: '/appointments', label: 'Appointments', icon: <Clock size={20} /> },
  { id: '/store', label: 'Store', icon: <Store size={20} /> },
  { id: '/email-marketing', label: 'Email Marketing', icon: <Mail size={20} /> },
  { id: '/social', label: 'Social Media', icon: <Globe size={20} /> },
  { id: '/google-business', label: 'Google Business', icon: <MapPin size={20} /> },
  { id: '/ai-chatbot', label: 'AI Chatbot', icon: <Bot size={20} /> },
  { id: '/creative', label: 'AI Content', icon: <Palette size={20} /> },
  { id: '/analytics', label: 'Analytics', icon: <BarChart3 size={20} /> },
];

// â”€â”€ Secondary sections (collapsed by default, expandable) â”€â”€
const menuSections: { label: string; items: MenuItem[] }[] = [
  {
    label: 'Growth',
    items: [
      { id: '/courses', label: 'Courses', icon: <GraduationCap size={20} /> },
      { id: '/funnels', label: 'Funnels', icon: <MessageCircle size={20} /> },
      { id: '/conversations', label: 'Conversations', icon: <MessageSquare size={20} /> },
    ],
  },
  {
    label: 'Marketing',
    items: [
      { id: '/surveys', label: 'Surveys & Forms', icon: <FormInput size={20} /> },
      { id: '/blog', label: 'Blog', icon: <PenTool size={20} /> },
      { id: '/review-requests', label: 'Review Requests', icon: <Star size={20} /> },
      { id: '/reviews', label: 'Reviews', icon: <Star size={20} /> },
    ],
  },
  {
    label: 'Operations',
    items: [
      { id: '/documents', label: 'Documents', icon: <FileText size={20} /> },
      { id: '/payment-links', label: 'Payment Links', icon: <CreditCard size={20} /> },
      { id: '/automation', label: 'Automation', icon: <Zap size={20} /> },
      { id: '/workflows', label: 'Workflows', icon: <Workflow size={20} /> },
    ],
  },
  {
    label: 'Tools',
    items: [
      { id: '/google-reviews-qr', label: 'Reviews QR', icon: <QrCode size={20} /> },
      { id: '/vcard-maker', label: 'V-Card Maker', icon: <CreditCard size={20} /> },
      { id: '/trigger-links', label: 'Trigger Links', icon: <Link size={20} /> },
      { id: '/reports', label: 'Reports', icon: <BarChart3 size={20} /> },
      { id: '/import-leads', label: 'Import', icon: <Upload size={20} /> },
    ],
  },
];

// â”€â”€ Settings (grouped into logical sections) â”€â”€
const settingsSections: { label: string; items: MenuItem[] }[] = [
  {
    label: 'Account',
    items: [
      { id: '/profile', label: 'Profile', icon: <Shield size={20} /> },
      { id: '/settings', label: 'Settings', icon: <Settings size={20} /> },
    ],
  },
  {
    label: 'Business',
    items: [
      { id: '/billing', label: 'Billing', icon: <CreditCard size={20} />, roles: ['OWNER', 'ADMIN'] },
      { id: '/team', label: 'Team', icon: <Users size={20} />, roles: ['OWNER', 'ADMIN'] },
      { id: '/api-keys', label: 'API Keys', icon: <Key size={20} />, roles: ['OWNER', 'ADMIN'] },
      { id: '/admin/users', label: 'User Management', icon: <Users size={20} />, roles: ['SUPER_ADMIN', 'OWNER', 'ADMIN'] },
    ],
  },
  {
    label: 'Product',
    items: [
      { id: '/custom-fields', label: 'Custom Fields', icon: <FormInput size={20} /> },
      { id: '/client-portal', label: 'Client Portal', icon: <Building2 size={20} /> },
      { id: '/agency', label: 'Agency', icon: <Building2 size={20} /> },
      { id: '/reseller-hub', label: 'Reseller Hub', icon: <Store size={20} /> },
    ],
  },
  {
    label: 'Tools',
    items: [
      { id: '/missed-call-settings', label: 'Missed Call', icon: <PhoneOff size={20} /> },
      { id: '/dograh-settings', label: 'Voice AI', icon: <Bot size={20} /> },
      { id: '/snapshots', label: 'Snapshots', icon: <Camera size={20} /> },
      { id: '/audit-log', label: 'Audit Log', icon: <Shield size={20} />, roles: ['OWNER', 'ADMIN'] },
      // BillInvoice (BizzBills) — only shown when the BIZZBILLS bundle is part
      // of this deployment. CRM-only standalone sales set VITE_BIZZBILLS_ENABLED=false.
      ...(import.meta.env.VITE_BIZZBILLS_ENABLED === 'true'
        ? [{ id: 'https://invoice.bizzautoai.com/dashboard', label: 'BillInvoice', icon: <FileCheck size={20} />, isExternal: true }]
        : []),
    ],
  },
];

// Bottom nav items for mobile (5 main items)
const bottomNavItems: MenuItem[] = [
  { id: '/dashboard', label: 'Home', icon: <Home size={22} /> },
  { id: '/whatsapp', label: 'Chat', icon: <MessageSquare size={22} /> },
  { id: '/crm', label: 'CRM', icon: <Users size={22} /> },
  { id: '/leads', label: 'Leads', icon: <UserPlus size={22} /> },
  { id: '/more', label: 'More', icon: <Menu size={22} /> },
];

interface AuthLayoutProps {
  children: React.ReactNode;
}

export default function AuthLayout({ children }: AuthLayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, business, logout } = useAuthStore();
  const { isDark, toggle: toggleTheme } = useThemeStore();
  const { isMobile, isTablet, isDesktop } = useViewport();
  const [showNotifications, setShowNotifications] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearchResults, setShowSearchResults] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);

  const isNative = MobileApp.isNative();
  const sidebarOpen = !collapsed;
  const showSidebarOverlay = isTablet && sidebarOpen;
  const userName = user?.name || 'Admin User';
  const userEmail = user?.email || 'admin@bizzauto.com';
  const userRole = user?.role || 'OWNER';
  const businessPlan = business?.plan || 'FREE';
  const { variant } = useDesignVariant();
  const isPremium = variant === 'premium';

  // Close notification dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setShowNotifications(false);
      }
    };
    if (showNotifications) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showNotifications]);

  // Close mobile menu on route change
  useEffect(() => {
    setShowMobileMenu(false);
  }, [location.pathname]);

  // Keyboard shortcut: Ctrl+K to focus search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setCollapsed(false);
        const searchInput = document.querySelector('.shell-search') as HTMLInputElement;
        if (searchInput) searchInput.focus();
      }
      if (e.key === 'Escape') {
        setShowSearchResults(false);
        setShowMobileMenu(false);
        setShowNotifications(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const isActive = (path: string) => {
    if (path === '/dashboard') return location.pathname === '/dashboard' || location.pathname === '/';
    return location.pathname === path || location.pathname.startsWith(path + '/');
  };

  // Friendly page title from path
  const getPageTitle = () => {
    const segments = location.pathname.split('/').filter(Boolean);
    if (segments.length === 0 || segments[0] === 'dashboard') return 'Dashboard';
    const nameMap: Record<string, string> = {
      'crm': 'CRM & Leads',
      'google-business': 'Google Business',
      'ai-chatbot': 'AI Chatbot',
      'email-marketing': 'Email Marketing',
      'social': 'Social Media',
      'billing': 'Billing & Plans',
      'team': 'Team Management',
      'api-keys': 'API Keys',
      'client-portal': 'Client Portal',
      'reseller-hub': 'Reseller Hub',
      'missed-call-settings': 'Missed Call Settings',
      'dograh-settings': 'Voice AI',
      'custom-fields': 'Custom Fields',
      'audit-log': 'Audit Log',
      'admin': 'Admin',
      'import-leads': 'Import Leads',
      'payment-links': 'Payment Links',
      'review-requests': 'Review Requests',
      'trigger-links': 'Trigger Links',
      'google-reviews-qr': 'Reviews QR',
      'vcard-maker': 'V-Card Maker',
    };
    const segment = segments[segments.length - 1];
    if (nameMap[segment]) return nameMap[segment];
    return segment.replace(/-/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
  };

  const filteredMenuItems = menuItems.filter(
    (item) => !item.roles || item.roles.includes(userRole)
  );

  const filteredSettingsSections = settingsSections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => !item.roles || item.roles.includes(userRole)),
    }))
    .filter((section) => section.items.length > 0);

  // Flat, searchable list of every navigable item (respecting role filters)
  const allNavItems = useMemo(() => {
    const base = [
      ...filteredMenuItems,
      ...menuSections.flatMap((s) => s.items),
      ...filteredSettingsSections.flatMap((s) => s.items),
    ];
    const seen = new Set<string>();
    return base.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }, [filteredMenuItems, filteredSettingsSections]);

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return allNavItems
      .filter((item) => item.label.toLowerCase().includes(q))
      .slice(0, 8);
  }, [searchQuery, allNavItems]);

  /**
   * External link opener (Option A bridge for BillInvoice).
   * For the BizzBills link, fetch a one-time bridge token from the CRM and
   * open the bridge URL — user lands logged-in. Falls back to the plain URL
   * on any error (bridge unconfigured / network fail).
   */
  const openExternal = useCallback(async (url: string) => {
    if (url.includes('invoice.bizzautoai.com')) {
      try {
        const res = await apiClient.get('/auth/bizzbills-bridge');
        const bridgeUrl = res.data?.data?.bridgeUrl;
        if (bridgeUrl) {
          window.open(bridgeUrl, '_blank', 'noopener,noreferrer');
          return;
        }
      } catch {
        // bridge unconfigured or failed — fall through to plain link
      }
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  const handleSearchSelect = (id: string) => {
    setSearchQuery('');
    setShowSearchResults(false);
    // External links (e.g. BillInvoice) must open in a new tab — navigate()
    // would resolve them as relative internal paths (/crm/https:/... → 404).
    if (id.startsWith('http')) {
      openExternal(id);
    } else {
      navigate(id);
    }
  };

  // Close search dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSearchResults(false);
      }
    };
    if (showSearchResults) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showSearchResults]);

  const handleBottomNavClick = (id: string) => {
    if (id === '/more') {
      setShowMobileMenu(!showMobileMenu);
    } else if (id.startsWith('http')) {
      // Defensive: never route external URLs through navigate()
      openExternal(id);
    } else {
      navigate(id);
    }
  };

  return (
    <div
      className="bg-gray-50 dark:bg-gray-900 flex"
      style={{ height: '100dvh', maxHeight: '100dvh', overflow: 'hidden' }}
    >
      {/* ===== TABLET BACKDROP (for slide-out sidebar) ===== */}
      {showSidebarOverlay && (
        <div
          className="lg:hidden fixed inset-0 bg-black/50 z-40 backdrop-blur-sm animate-fade-in-up"
          onClick={() => setCollapsed(true)}
        />
      )}

      {/* ===== SIDEBAR ===== */}
      {/* Mobile: completely hidden */}
      {/* Tablet (md-lg): slide-out drawer with w-72 (fixed position) */}
      {/* Desktop (lg+): always visible, collapsible w-64/w-20 (flex item, not fixed) */}
      <div
        className={`shell-sidebar flex-col transition-all duration-300 ${
          isPremium ? 'dp-sidebar' : ''
        } ${
          isMobile ? 'hidden' :
          isTablet ? `fixed left-0 top-0 z-50 ${sidebarOpen ? 'flex w-72 shadow-2xl' : 'hidden'}` :
          `flex flex-shrink-0 ${collapsed ? 'w-20' : 'w-64'}`
        }`}
        style={{ height: '100dvh', maxHeight: '100dvh', overflow: 'hidden' }}
      >
        {/* Logo */}
        <div className="shell-brand p-5">
          <div className="flex items-center gap-3">
            <img src={(window as any).__WL_BRANDING?.logoUrl || "/logo.svg"} alt={(window as any).__WL_BRANDING?.brandName || "BizzAuto AI Logo"} className="h-9 w-auto flex-shrink-0" />
            {!collapsed && (
              <div className="min-w-0">
                <p className="text-white font-semibold text-[15px] leading-tight truncate">{getWLBrandShort()}</p>
                <p className="text-[10px] text-slate-400 leading-tight truncate">Business OS</p>
              </div>
            )}
          </div>
        </div>

        {/* Global search */}
        {!collapsed && (
          <div className="px-3 pt-3" ref={searchRef}>
            <div className="relative">
              <Search
                size={15}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setShowSearchResults(true);
                }}
                onFocus={() => searchQuery && setShowSearchResults(true)}
                placeholder="Searchâ€¦ (Ctrl+K)"
                className="shell-search w-full rounded-lg pl-9 pr-3 py-2 text-sm placeholder:text-slate-500 focus:outline-none"
                aria-label="Search"
              />

              {/* Results dropdown */}
              {showSearchResults && searchQuery.trim() && (
                <div className="absolute left-0 right-0 top-full mt-2 z-50 rounded-xl border border-white/10 bg-slate-800 shadow-2xl overflow-hidden">
                  {searchResults.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-slate-400">No matches found</p>
                  ) : (
                    <ul className="max-h-72 overflow-y-auto py-1">
                      {searchResults.map((item) => (
                        <li key={item.id}>
                          <button
                            onClick={() => handleSearchSelect(item.id)}
                            className="w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm text-slate-200 hover:bg-white/5 transition-colors"
                          >
                            <span className="text-slate-400">{item.icon}</span>
                            <span className="truncate">{item.label}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Navigation */}
        <nav className="flex-1 px-3 py-3 overflow-y-auto space-y-1" style={{ maxHeight: 'calc(100vh - 220px)' }}>
          {filteredMenuItems.map((item) => {
            const active = isActive(item.id);
            return (
              <button
                key={item.id}
                onClick={() => item.id.startsWith("http") ? openExternal(item.id) : navigate(item.id)}
                className={`shell-nav-item btn-press relative w-full flex items-center justify-between px-3 py-2.5 rounded-xl group ${
                  active ? 'shell-nav-item-active font-medium' : ''
                }`}
                title={collapsed ? item.label : undefined}
              >
                {active && <span className="shell-nav-indicator" />}
                <div className="flex items-center gap-3">
                  <span className={`shell-nav-icon transition-transform duration-200 ${active ? 'scale-110' : 'group-hover:scale-105'}`}>
                    {item.icon}
                  </span>
                  {!collapsed && <span className="text-sm">{item.label}</span>}
                </div>
                {!collapsed && item.badge && (
                  <span className="bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 pulse-dot">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}

          {menuSections.map((section) => (
            <div key={section.label}>
              <hr className="shell-section-rule my-3" />
              {!collapsed && (
                <p className="shell-section-label px-3 mb-1">{section.label}</p>
              )}
              {section.items.map((item) => {
                const active = isActive(item.id);
                return (
                  <button
                    key={item.id}
                    onClick={() => item.id.startsWith("http") ? openExternal(item.id) : navigate(item.id)}
                    className={`shell-nav-item btn-press relative w-full flex items-center gap-3 px-3 py-2.5 rounded-xl group ${
                      active ? 'shell-nav-item-active font-medium' : ''
                    }`}
                    title={collapsed ? item.label : undefined}
                  >
                    {active && <span className="shell-nav-indicator" />}
                    <span className={`shell-nav-icon transition-transform duration-200 ${active ? 'scale-110' : 'group-hover:scale-105'}`}>
                      {item.icon}
                    </span>
                    {!collapsed && <span className="text-sm">{item.label}</span>}
                  </button>
                );
              })}
            </div>
          ))}

          <hr className="shell-section-rule my-3" />

          {filteredSettingsSections.map((section) => (
            <div key={section.label}>
              {!collapsed && (
                <p className="shell-section-label px-3 mb-1 mt-1">{section.label}</p>
              )}
              {section.items.map((item) => {
                const active = isActive(item.id);
                return (
                  <button
                    key={item.id}
                    onClick={() => item.id.startsWith("http") ? openExternal(item.id) : navigate(item.id)}
                    className={`shell-nav-item btn-press relative w-full flex items-center gap-3 px-3 py-2.5 rounded-xl group ${
                      active ? 'shell-nav-item-active font-medium' : ''
                    }`}
                    title={collapsed ? item.label : undefined}
                  >
                    {active && <span className="shell-nav-indicator" />}
                    <span className={`shell-nav-icon transition-transform duration-200 ${active ? 'scale-110' : 'group-hover:scale-105'}`}>
                      {item.icon}
                    </span>
                    {!collapsed && <span className="text-sm">{item.label}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Plan upgrade CTA (free/low tiers only) */}
        {!collapsed && businessPlan === 'FREE' && (
          <div className="px-3">
            <button
              onClick={() => navigate('/billing')}
              className="shell-cta w-full rounded-xl p-3 text-left transition-all duration-200 hover-lift"
            >
              <p className="text-white text-sm font-semibold">Unlock Pro</p>
              <p className="text-white/70 text-[11px] leading-tight mt-0.5">
                Automations, CRM & more
              </p>
            </button>
          </div>
        )}

        {/* User Profile */}
        <div className="p-3 border-t border-white/10">
          <button
            onClick={() => navigate('/profile')}
            className="shell-nav-item flex items-center gap-3 w-full hover:bg-white/5 rounded-xl p-2.5"
            title={collapsed ? 'Profile' : undefined}
          >
            <div className="w-9 h-9 bg-blue-600 rounded-full flex items-center justify-center text-white font-semibold text-sm flex-shrink-0">
              {(userName || 'A').charAt(0).toUpperCase()}
            </div>
            {!collapsed && (
              <div className="flex-1 text-left min-w-0">
                <p className="text-sm font-medium text-white truncate">{userName}</p>
                <p className="text-[11px] text-gray-400 truncate">{userEmail}</p>
              </div>
            )}
          </button>
          <LanguageSwitcher collapsed={collapsed} />
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 w-full hover:bg-red-500/10 rounded-xl p-2.5 transition-colors mt-1 text-gray-400 hover:text-red-400"
            title={collapsed ? 'Sign Out' : undefined}
          >
            <LogOut size={16} />
            {!collapsed && <span className="text-sm">Sign Out</span>}
          </button>
        </div>
      </div>

      {/* ===== MAIN CONTENT AREA ===== */}
      {/* On desktop, sidebar is a flex item so no margin needed â€” flex-1 handles sizing */}
      <div className={`flex-1 flex flex-col min-w-0 transition-all duration-300 ${
        isMobile ? 'ml-0' :
        isTablet ? (sidebarOpen ? 'ml-72' : 'ml-0') :
        ''
      }`}>
        {/* ===== MOBILE TOP BAR (visible only on mobile) =====
            Solid bg (no backdrop-blur) â€” kills Android scroll perf. */}
        <div className="shell-topbar-mobile md:hidden px-3 sm:px-4 py-2.5 sm:py-3 flex items-center justify-between sticky top-0 z-40 ios-status-bar" style={{ transform: 'translateZ(0)' }}>
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
            <div className="w-7 h-7 sm:w-8 sm:h-8 bg-blue-600 rounded-lg flex items-center justify-center flex-shrink-0">
              <Zap size={14} className="text-white sm:w-4 sm:h-4" />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-xs sm:text-sm font-bold text-white truncate">{getWLBrandShort()}</h1>
              <p className="text-[10px] text-slate-300 truncate">
                {getPageTitle()}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
            <button
              onClick={toggleTheme}
              className="shell-icon-btn p-1.5 sm:p-2 rounded-lg"
              aria-label="Toggle theme"
            >
              {isDark ? <Sun size={16} className="sm:w-[18px] sm:h-[18px] text-slate-300" /> : <Moon size={16} className="sm:w-[18px] sm:h-[18px] text-slate-300" />}
            </button>
            <div className="relative" ref={notifRef}>
              <button
                onClick={() => setShowNotifications(!showNotifications)}
                className="shell-icon-btn relative p-1.5 sm:p-2 rounded-lg"
                aria-label="Notifications"
              >
                <Bell size={16} className="sm:w-[18px] sm:h-[18px] text-slate-300" />
                <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full"></span>
              </button>
              {showNotifications && (
                <div className="absolute right-0 top-10 sm:top-12 z-50">
                  <NotificationCenter
                    onNavigate={(tab) => {
                      navigate(tab);
                      setShowNotifications(false);
                    }}
                    onClose={() => setShowNotifications(false)}
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ===== TABLET TOP BAR ===== */}
        <div className={`shell-topbar hidden md:flex lg:hidden px-4 sm:px-6 py-3 items-center justify-between sticky top-0 z-40 ${isPremium ? 'dp-topbar' : ''}`}>
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <button
              onClick={() => setCollapsed(!collapsed)}
              className="shell-icon-btn p-2 rounded-lg flex-shrink-0"
              title="Toggle sidebar"
              aria-label="Toggle sidebar"
            >
              <Menu size={20} />
            </button>
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-slate-400 text-sm">/</span>
              <div className="text-base font-semibold text-slate-900 dark:text-white truncate">
                {getPageTitle()}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
            <span className="shell-pill hidden sm:inline-flex px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg text-xs sm:text-sm font-medium">
              {userRole}
            </span>
            <button onClick={toggleTheme} className="shell-icon-btn p-2 rounded-lg" aria-label="Toggle theme">
              {isDark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <div className="relative" ref={notifRef}>
              <button
                onClick={() => setShowNotifications(!showNotifications)}
                className="shell-icon-btn relative p-2 rounded-lg"
                aria-label="Notifications"
              >
                <Bell size={18} />
                <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full"></span>
              </button>
              {showNotifications && (
                <div className="absolute right-0 top-12 z-50">
                  <NotificationCenter
                    onNavigate={(tab) => {
                      navigate(tab);
                      setShowNotifications(false);
                    }}
                    onClose={() => setShowNotifications(false)}
                  />
                </div>
              )}
            </div>
            {businessPlan === 'FREE' && (
              <button onClick={() => navigate('/billing')} className="hidden sm:inline-flex items-center gap-2 px-3 py-1.5 bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 rounded-lg text-xs font-semibold hover:bg-amber-100 dark:hover:bg-amber-900/50 transition-colors">
                âš¡ Upgrade Plan
              </button>
            )}
          </div>
        </div>

        {/* ===== DESKTOP TOP BAR ===== */}
        <div className={`shell-topbar hidden lg:flex px-6 xl:px-8 py-3.5 items-center justify-between sticky top-0 z-40 ${isPremium ? 'dp-topbar' : ''}`}>
          <div className="flex items-center gap-4 flex-1 min-w-0">
            <button
              onClick={() => setCollapsed(!collapsed)}
              className="shell-icon-btn p-2 rounded-lg flex-shrink-0"
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-label="Toggle sidebar"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={collapsed ? 'M13 5l7 7-7 7M5 5l7 7-7 7' : 'M11 19l-7-7 7-7m8 14l-7-7 7-7'} />
              </svg>
            </button>
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-slate-400 text-lg">/</span>
              <div className="text-lg font-semibold text-slate-900 dark:text-white truncate">
                {getPageTitle()}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4 flex-shrink-0">
            <span className="shell-pill px-3 py-1.5 rounded-lg text-sm font-medium">
              {userRole}
            </span>
            <button onClick={toggleTheme} className="shell-icon-btn p-2 rounded-lg" aria-label="Toggle theme">
              {isDark ? <Sun size={20} /> : <Moon size={20} />}
            </button>
            <div className="relative" ref={notifRef}>
              <button
                onClick={() => setShowNotifications(!showNotifications)}
                className="shell-icon-btn relative p-2 rounded-lg"
                aria-label="Notifications"
              >
                <Bell size={20} />
                <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full"></span>
              </button>
              {showNotifications && (
                <div className="absolute right-0 top-12 z-50">
                  <NotificationCenter
                    onNavigate={(tab) => {
                      navigate(tab);
                      setShowNotifications(false);
                    }}
                    onClose={() => setShowNotifications(false)}
                  />
                </div>
              )}
            </div>
            {businessPlan === 'FREE' && (
              <button onClick={() => navigate('/billing')} className="inline-flex items-center gap-2 px-4 py-2 bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 rounded-lg text-sm font-semibold hover:bg-amber-100 dark:hover:bg-amber-900/50 transition-colors">
                âš¡ Upgrade Plan
              </button>
            )}
          </div>
        </div>

        {/* ===== PAGE CONTENT ===== */}
        <div
          className={`flex-1 overflow-y-auto ${isPremium ? 'dp-content' : ''}`}
          style={{
            minHeight: '0px',
            paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            overscrollBehavior: 'contain',
          }}
        >
          <div className="pb-16 md:pb-0">
            {children}
          </div>
        </div>
      </div>

      {/* ===== AVA EXECUTIVE ASSISTANT ===== */}
      <AvaExecutiveAssistant />

      {/* ===== MOBILE BOTTOM NAVIGATION (visible only on mobile) ===== */}
      <div className="md:hidden mobile-bottom-nav">
        <div className="flex items-center justify-around py-1.5 sm:py-2 px-1 sm:px-2">
          {bottomNavItems.map((item) => (
            <button
              key={item.id}
              onClick={() => handleBottomNavClick(item.id)}
              className={`relative flex flex-col items-center justify-center py-1 px-1.5 sm:px-3 rounded-xl transition-all duration-200 min-w-[50px] sm:min-w-[56px] ${
                item.id === '/more'
                  ? 'text-gray-500 dark:text-gray-400'
                  : isActive(item.id)
                  ? 'text-blue-600 dark:text-blue-400'
                  : 'text-gray-500 dark:text-gray-400'
              }`}
            >
              <span className={isActive(item.id) && item.id !== '/more' ? 'scale-110' : ''}>
                {item.icon}
              </span>
              <span className={`text-[9px] sm:text-[10px] mt-0.5 font-medium ${
                isActive(item.id) && item.id !== '/more' ? 'text-blue-600 dark:text-blue-400' : ''
              }`}>
                {item.label}
              </span>
              {item.badge && (
                <span className="absolute -top-0.5 right-0.5 sm:right-1 bg-red-500 text-white text-[8px] font-bold rounded-full min-w-[14px] h-[14px] flex items-center justify-center px-0.5">
                  {item.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ===== MOBILE SLIDE-OUT MENU (More options) ===== */}
      {showMobileMenu && (
        <div className="md:hidden fixed inset-0 z-[60]">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setShowMobileMenu(false)} />
          
          {/* Menu Panel */}
          <div className="absolute bottom-0 left-0 right-0 bg-white dark:bg-gray-900 rounded-t-3xl max-h-[75vh] overflow-y-auto mobile-safe-bottom animate-slide-up">
            {/* Handle bar */}
            <div className="flex justify-center pt-3 pb-2">
              <div className="w-10 h-1 bg-gray-300 dark:bg-gray-600 rounded-full" />
            </div>
            
            {/* User info */}
            <div className="px-5 pb-4 border-b border-gray-200 dark:border-gray-700">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 bg-blue-600 rounded-full flex items-center justify-center text-white font-semibold text-lg">
                  {(userName || 'A').charAt(0).toUpperCase()}
                </div>
                <div>
                  <p className="font-semibold text-gray-900 dark:text-white">{userName}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{userEmail}</p>
                  <span className="inline-block mt-1 px-2 py-0.5 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 text-[10px] font-medium rounded-full">
                    {businessPlan} Plan â€¢ {userRole}
                  </span>
                </div>
              </div>
            </div>

            {/* Menu items grid */}
            <div className="p-4 grid grid-cols-3 gap-2">
              {filteredMenuItems.filter(item => !bottomNavItems.find(b => b.id === item.id)).map((item) => (
                <button
                  key={item.id}
                  onClick={() => item.id.startsWith("http") ? openExternal(item.id) : navigate(item.id)}
                  className={`flex flex-col items-center gap-1.5 p-3 rounded-xl transition-all ${
                    isActive(item.id)
                      ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                      : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                  }`}
                >
                  {item.icon}
                  <span className="text-[11px] font-medium text-center leading-tight">{item.label}</span>
                </button>
              ))}
            </div>

            {/* New feature sections */}
            {menuSections.map((section) => (
              <div key={section.label} className="px-4 pb-3 border-t border-gray-200 dark:border-gray-700 pt-3">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">{section.label}</p>
                <div className="grid grid-cols-3 gap-2">
                  {section.items.map((item) => (
                    <button
                      key={item.id}
              onClick={() => item.isExternal ? openExternal(item.id) : navigate(item.id)}
                      className={`flex flex-col items-center gap-1.5 p-3 rounded-xl transition-all ${
                        isActive(item.id)
                          ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                          : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                      }`}
                    >
                      {item.icon}
                      <span className="text-[11px] font-medium text-center leading-tight">{item.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}

            {/* Settings sections */}
            <div className="px-4 pb-4 border-t border-gray-200 dark:border-gray-700 pt-3">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">Settings</p>
              {filteredSettingsSections.map((section) => (
                <div key={section.label} className="mb-3 last:mb-0">
                  <p className="text-[10px] font-semibold text-gray-300 dark:text-gray-600 uppercase tracking-wider mb-1 px-1">{section.label}</p>
                  <div className="space-y-1">
                    {section.items.map((item) => (
                      <button
                        key={item.id}
                        onClick={() => item.id.startsWith("http") ? openExternal(item.id) : navigate(item.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all ${
                          isActive(item.id)
                            ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                            : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                        }`}
                      >
                        {item.icon}
                        <span className="text-sm">{item.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Version Badge */}
            <div className="px-4 pb-2 pt-2">
              <div className="flex items-center justify-center gap-2 px-3 py-2 bg-gradient-to-r from-green-500/10 to-emerald-500/10 border border-green-500/20 rounded-xl">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                <span className="text-[10px] font-mono text-green-600 dark:text-green-400">
                  v12.0.1 â€¢ {new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                </span>
              </div>
            </div>

            {/* Logout */}
            <div className="px-4 pb-6 pt-2 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={handleLogout}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-xl font-medium text-sm"
              >
                <LogOut size={18} />
                Sign Out
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
