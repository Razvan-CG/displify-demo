import {
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Subscription } from 'rxjs';
import {
  trigger,
  state,
  style,
  transition,
  animate,
  group,
  query,
  animateChild,
} from '@angular/animations';

import { PostMessageService } from '../../services/post-message.service';
import { IframeHealthStatus, LayoutState } from '../../models/iframe-message.model';

// ─────────────────────────────────────────────
//  Animation definitions
// ─────────────────────────────────────────────

/**
 * Layout Morphing animation.
 * Uses a flex-based approach so the KPI panel expands while
 * the AI panel slides out to the right with a stagger feel.
 */
const layoutAnimation = trigger('layoutMorph', [
  state('overview', style({
    // KPI 70% | AI 30%  (expressed as flex on children via CSS)
  })),
  state('focus', style({
    // KPI 100% | AI 0%
  })),
  transition('overview => focus', [
    group([
      query('.kpi-panel', [
        animate('400ms ease-in-out', style({ flex: '1 1 100%' })),
      ], { optional: true }),
      query('.ai-panel', [
        animate('400ms 80ms ease-in-out', style({
          flex: '0 0 0%',
          opacity: 0,
          transform: 'translateX(60px)',
        })),
      ], { optional: true }),
    ]),
  ]),
  transition('focus => overview', [
    group([
      query('.kpi-panel', [
        animate('350ms ease-in-out', style({ flex: '1 1 70%' })),
      ], { optional: true }),
      query('.ai-panel', [
        style({ transform: 'translateX(60px)', opacity: 0 }),
        animate('350ms 60ms ease-out', style({
          flex: '1 1 30%',
          opacity: 1,
          transform: 'translateX(0)',
        })),
      ], { optional: true }),
    ]),
  ]),
]);

/**
 * Neon-pulse animation for the Visual Bus.
 * Applied to individual panels when data flows through them.
 */
const neonPulse = trigger('neonPulse', [
  state('idle', style({ boxShadow: '0 0 0 0 transparent' })),
  state('active', style({ boxShadow: '0 0 12px 2px rgba(99, 102, 241, 0.7)' })),
  transition('idle => active', animate('150ms ease-in')),
  transition('active => idle', animate('400ms ease-out')),
]);

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
  animations: [layoutAnimation, neonPulse],
})
export class DashboardComponent implements OnInit, OnDestroy {

  // ── Layout state ──────────────────────────────
  currentLayout: LayoutState = 'overview';

  // ── Signage mode ──────────────────────────────
  isSignageMode = false;

  // ── Fullscreen ────────────────────────────────
  isFullscreen = false;

  // ── Shell visibility ──────────────────────────
  isShellVisible = true;

  // ── Crash controls visibility ─────────────────
  showCrashControls = false;

  // ── Sanitized iframe URLs ─────────────────────
  kpiAppUrl!: SafeResourceUrl;
  aiAppUrl!: SafeResourceUrl;
  weatherAppUrl!: SafeResourceUrl;

  // ── Iframe readiness flags ────────────────────
  kpiIframeReady = false;
  aiIframeReady = false;
  weatherIframeReady = false;

  // ── Weather / AI cycle switching ──────────────
  showWeather = false;
  private aiCycleCount = 0;
  private cycleTimer: ReturnType<typeof setInterval> | null = null;

  // ── Visual Bus — neon pulse states ────────────
  kpiPulse: 'idle' | 'active' = 'idle';
  aiPulse:  'idle' | 'active' = 'idle';

  // ── Crash Recovery — status dots ──────────────
  kpiStatus: 'healthy' | 'crashed' | 'recovering' = 'healthy';
  aiStatus:  'healthy' | 'crashed' | 'recovering' = 'healthy';
  weatherStatus: 'healthy' | 'crashed' | 'recovering' = 'healthy';

  // ── Heartbeat Health ──────────────────────────
  kpiHealth: IframeHealthStatus = 'online';
  aiHealth:  IframeHealthStatus = 'online';
  weatherHealth: IframeHealthStatus = 'online';
  kpiMissedPings = 0;
  aiMissedPings  = 0;
  weatherMissedPings = 0;

  // ── Iframe element references ─────────────────
  @ViewChild('kpiIframe', { static: false })     kpiIframeRef!: ElementRef<HTMLIFrameElement>;
  @ViewChild('aiIframe', { static: false })      aiIframeRef!: ElementRef<HTMLIFrameElement>;
  @ViewChild('weatherIframe', { static: false }) weatherIframeRef!: ElementRef<HTMLIFrameElement>;

  private subscriptions: Subscription[] = [];

  constructor(
    private readonly sanitizer: DomSanitizer,
    private readonly postMessageService: PostMessageService,
    private readonly zone: NgZone,
  ) {}

  // ─────────────────────────────────────────────
  //  Lifecycle
  // ─────────────────────────────────────────────

  private readonly onFullscreenChange = (): void => {
    this.zone.run(() => {
      this.isFullscreen = !!document.fullscreenElement;
    });
  };

  ngOnInit(): void {
    document.addEventListener('fullscreenchange', this.onFullscreenChange);

    // ── Read URL params ──────────────────────────
    const params = new URLSearchParams(window.location.search);
    const modeParam       = params.get('mode');
    const shellParam      = params.get('shell');
    const fullscreenParam = params.get('fullscreen');
    const intervalParam   = params.get('interval');

    // Apply shell visibility
    if (shellParam === 'off') {
      this.isShellVisible = false;
    }

    // Apply signage mode
    if (modeParam === 'signage') {
      this.isSignageMode = true;
    }

    // Apply fullscreen (must be triggered after a user gesture; attempt on load)
    if (fullscreenParam === 'true') {
      document.documentElement.requestFullscreen().then(() => {
        this.isFullscreen = true;
      }).catch(() => { /* browser may block auto-fullscreen without gesture */ });
    }

    // Build KPI URL with mode and interval params if signage is active
    const kpiUrl = this.isSignageMode
      ? `assets/kpi-app.html?mode=signage${intervalParam ? '&interval=' + intervalParam : ''}`
      : 'assets/kpi-app.html';
    this.kpiAppUrl = this.sanitizer.bypassSecurityTrustResourceUrl(kpiUrl);
    this.aiAppUrl = this.sanitizer.bypassSecurityTrustResourceUrl(
      'assets/ai-app.html',
    );
    this.weatherAppUrl = this.sanitizer.bypassSecurityTrustResourceUrl(
      'assets/weather-app.html',
    );

    // ── Cycle timer: 3/5 AI, 2/5 Weather ──
    const cycleIntervalMs = (parseInt(intervalParam || '10', 10)) * 1000;
    this.cycleTimer = setInterval(() => {
      this.zone.run(() => {
        this.aiCycleCount = (this.aiCycleCount + 1) % 5;
        // Cycles 0,1,2 → AI | Cycles 3,4 → Weather
        const wasWeather = this.showWeather;
        this.showWeather = this.aiCycleCount >= 3;
        if (this.showWeather !== wasWeather) {
          if (this.showWeather) {
            this.postMessageService.sendMessageTo('AI_APP', { type: 'HOLD', target: 'AI_APP', payload: { hold: true } });
            this.postMessageService.sendMessageTo('WEATHER_APP', { type: 'HOLD', target: 'WEATHER_APP', payload: { hold: false } });
          } else {
            this.postMessageService.sendMessageTo('WEATHER_APP', { type: 'HOLD', target: 'WEATHER_APP', payload: { hold: true } });
            this.postMessageService.sendMessageTo('AI_APP', { type: 'HOLD', target: 'AI_APP', payload: { hold: false } });
          }
        }
      });
    }, cycleIntervalMs);

    // Layout changes from the broker.
    this.subscriptions.push(
      this.postMessageService.layoutChanged$.subscribe((layout) => {
        this.zone.run(() => {
          this.currentLayout = layout;
        });
      }),
    );

    // Visual Bus — flash neon borders on data transfer.
    this.subscriptions.push(
      this.postMessageService.messagePulse$.subscribe(({ from, to }) => {
        this.zone.run(() => this.flashNeonPulse(from, to));
      }),
    );

    // Crash Recovery — status dot updates.
    this.subscriptions.push(
      this.postMessageService.appStatus$.subscribe(({ id, status }) => {
        this.zone.run(() => {
          if (id === 'KPI_APP') {
            this.kpiStatus = status;
            if (status === 'crashed' || status === 'recovering') { this.kpiIframeReady = false; }
          }
          if (id === 'AI_APP') {
            this.aiStatus = status;
            if (status === 'crashed' || status === 'recovering') { this.aiIframeReady = false; }
          }
          if (id === 'WEATHER_APP') {
            this.weatherStatus = status;
            if (status === 'crashed' || status === 'recovering') { this.weatherIframeReady = false; }
          }
        });
      }),
    );

    // Heartbeat — health status updates for System Health dashboard.
    this.subscriptions.push(
      this.postMessageService.iframeHealth$.subscribe((healthMap) => {
        this.zone.run(() => {
          const kpi     = healthMap.get('KPI_APP');
          const ai      = healthMap.get('AI_APP');
          const weather = healthMap.get('WEATHER_APP');
          if (kpi)     { this.kpiHealth     = kpi.status;     this.kpiMissedPings     = kpi.missedPings; }
          if (ai)      { this.aiHealth      = ai.status;      this.aiMissedPings      = ai.missedPings; }
          if (weather) { this.weatherHealth = weather.status; this.weatherMissedPings = weather.missedPings; }
        });
      }),
    );
  }

  ngOnDestroy(): void {
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    if (this.cycleTimer) { clearInterval(this.cycleTimer); }
    this.subscriptions.forEach((s) => s.unsubscribe());
    this.postMessageService.unregisterIframe('KPI_APP');
    this.postMessageService.unregisterIframe('AI_APP');
    this.postMessageService.unregisterIframe('WEATHER_APP');
  }

  // ─────────────────────────────────────────────
  //  Iframe onload handlers
  // ─────────────────────────────────────────────

  onKpiIframeLoad(): void {
    this.kpiIframeReady = true;
    this.kpiStatus = 'healthy';

    this.postMessageService.registerIframe(
      'KPI_APP',
      this.kpiIframeRef.nativeElement,
    );

    this.postMessageService.sendMessageTo('KPI_APP', {
      type: 'DATA_UPDATE',
      target: 'KPI_APP',
      payload: { shellReady: true },
    });
  }

  onAiIframeLoad(): void {
    this.aiIframeReady = true;
    this.aiStatus = 'healthy';

    this.postMessageService.registerIframe(
      'AI_APP',
      this.aiIframeRef.nativeElement,
    );

    this.postMessageService.sendMessageTo('AI_APP', {
      type: 'DATA_UPDATE',
      target: 'AI_APP',
      payload: { shellReady: true },
    });
  }

  onWeatherIframeLoad(): void {
    this.weatherIframeReady = true;

    this.postMessageService.registerIframe(
      'WEATHER_APP',
      this.weatherIframeRef.nativeElement,
    );

    // Weather starts hidden — hold it until the cycle brings it to foreground
    this.postMessageService.sendMessageTo('WEATHER_APP', {
      type: 'HOLD',
      target: 'WEATHER_APP',
      payload: { hold: true },
    });
  }

  // ─────────────────────────────────────────────
  //  Layout helpers
  // ─────────────────────────────────────────────

  resetLayout(): void {
    this.currentLayout = 'overview';
  }

  // ─────────────────────────────────────────────
  //  Visual Bus — neon border flash
  // ─────────────────────────────────────────────

  private flashNeonPulse(from: string, to: string): void {
    // Flash the source panel first, then the destination.
    if (from === 'KPI_APP') { this.kpiPulse = 'active'; }
    if (from === 'AI_APP')  { this.aiPulse  = 'active'; }

    setTimeout(() => {
      if (to === 'AI_APP')  { this.aiPulse  = 'active'; }
      if (to === 'KPI_APP') { this.kpiPulse = 'active'; }
    }, 200);

    // Reset both after the full animation cycle.
    setTimeout(() => {
      this.zone.run(() => {
        this.kpiPulse = 'idle';
        this.aiPulse  = 'idle';
      });
    }, 700);
  }

  // ─────────────────────────────────────────────
  //  Fail Simulation – delegate to broker
  // ─────────────────────────────────────────────

  restartApp(iframeId: string): void {
    if (iframeId === 'KPI_APP') { this.kpiIframeReady = false; this.kpiStatus = 'crashed'; }
    if (iframeId === 'AI_APP')      { this.aiIframeReady = false;      this.aiStatus = 'crashed'; }
    if (iframeId === 'WEATHER_APP') { this.weatherIframeReady = false; this.weatherStatus = 'crashed'; }

    // The broker will flip status to 'recovering' then (load) → 'healthy'.
    setTimeout(() => this.postMessageService.restartApp(iframeId), 1000);
  }

  // ─────────────────────────────────────────────
  //  Kill App — sends KILL message to an iframe
  // ─────────────────────────────────────────────

  killApp(iframeId: string): void {
    this.postMessageService.killApp(iframeId);
  }

  toggleCrashControls(): void {
    this.showCrashControls = !this.showCrashControls;
    const msg = { type: 'TOGGLE_CRASH_BTN' as const, payload: { visible: this.showCrashControls } };
    this.postMessageService.sendMessageTo('KPI_APP', { ...msg, target: 'KPI_APP' });
    this.postMessageService.sendMessageTo('AI_APP',      { ...msg, target: 'AI_APP'      });
    this.postMessageService.sendMessageTo('WEATHER_APP', { ...msg, target: 'WEATHER_APP' });
  }

  // ─────────────────────────────────────────────
  //  Signage mode toggle
  // ─────────────────────────────────────────────

  toggleSignageMode(): void {
    this.isSignageMode = !this.isSignageMode;
    const interval = new URLSearchParams(window.location.search).get('interval');
    const url = this.isSignageMode
      ? `assets/kpi-app.html?mode=signage${interval ? '&interval=' + interval : ''}`
      : 'assets/kpi-app.html';
    this.kpiAppUrl = this.sanitizer.bypassSecurityTrustResourceUrl(url);
    this.kpiIframeReady = false;
  }

  // ─────────────────────────────────────────────
  //  Fullscreen toggle
  // ─────────────────────────────────────────────

  toggleFullscreen(): void {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
    // isFullscreen is updated by the 'fullscreenchange' event listener
  }

  // ─────────────────────────────────────────────
  //  Shell visibility toggle
  // ─────────────────────────────────────────────

  toggleShell(): void {
    this.isShellVisible = !this.isShellVisible;
  }
}
