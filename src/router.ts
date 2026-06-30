import { createRouter, createWebHashHistory } from 'vue-router';
import Home from './views/Home.vue';
import Search from './views/Search.vue';
import Settings from './views/Settings.vue';
import Live from './views/Live.vue';
import History from './views/History.vue';
import Favorites from './views/Favorites.vue';
import Drive from './views/Drive.vue';

const routes = [
  { path: '/', component: Home },
  { path: '/search', component: Search },
  { path: '/live', component: Live },
  { path: '/history', component: History },
  { path: '/favorites', component: Favorites },
  { path: '/drive', component: Drive },
  { path: '/settings', component: Settings },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
