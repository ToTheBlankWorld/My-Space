import { Engine } from '@/components/landing/engine';
import { Hero } from '@/components/landing/hero';
import { Overview } from '@/components/landing/overview';
import { Roadmap } from '@/components/landing/roadmap';
import { SiteFooter } from '@/components/landing/site-footer';
import { SiteHeader } from '@/components/landing/site-header';

const LandingPage = () => (
  <>
    <SiteHeader />
    <main id="main">
      <Hero />
      <Overview />
      <Engine />
      <Roadmap />
    </main>
    <SiteFooter />
  </>
);

export default LandingPage;
