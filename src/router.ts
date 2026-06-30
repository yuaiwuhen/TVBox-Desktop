import { createRouter, createWebHashHistory } from 'vue-router';
import Home from './views/Home.vue';
import Search from './views/Search.vue';
import Settings from './views/Settings.vue';
import Live from './views/Live.vue';
import History from './views/History.vue';
import Favorites from './views/Favorites.vue';
import Drive from './views/Drive.vue';
import Detail from './views/Detail.vue';

const routes = [
  { path: '/', component: Home, name: 'home' },
  { path: '/search', component: Search, name: 'search' },
  { path: '/live', component: Live, name: 'live' },
  { path: '/history', component: History, name: 'history' },
  { path: '/favorites', component: Favorites, name: 'favorites' },
  { path: '/drive', component: Drive, name: 'drive' },
  { path: '/settings', component: Settings, name: 'settings' },
  { path: '/detail/:sourceKey/:vodId', component: Detail, name: 'detail' },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
