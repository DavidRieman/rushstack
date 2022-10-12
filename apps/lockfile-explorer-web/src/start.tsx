// eslint-disable-next-line @typescript-eslint/no-unused-vars
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { App } from './App';

import './start.css';
import { store } from './store';
import { Provider } from 'react-redux';

const rootDiv: HTMLElement = document.getElementById('root') as HTMLElement;
ReactDOM.render(
  <Provider store={store}>
    <App />
  </Provider>,
  rootDiv
);
