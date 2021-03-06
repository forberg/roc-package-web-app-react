import config from 'config';
import debug from 'debug';
import nunjucks from 'nunjucks';
import serialize from 'serialize-javascript';
import PrettyError from 'pretty-error';
import React from 'react';
import { renderToString, renderToStaticMarkup } from 'react-dom/server';
import { match, applyRouterMiddleware } from 'react-router';
import { Provider } from 'react-redux';
import Helmet from 'react-helmet';
import { triggerHooks, useRedial } from 'react-router-redial';
import { getAbsolutePath, getSettings } from 'roc';
import ServerStatus from 'react-server-status';

import myPath from './helpers/myPath';

const pretty = new PrettyError();
const log = debug('roc:react-render');

const rocConfig = getSettings();

const whiteListed = () => (
    rocConfig.runtime.configWhitelistProperty ?
        config[rocConfig.runtime.configWhitelistProperty] :
        undefined
);

const appConfig = whiteListed();

export function initRenderPage({ script, css }, distMode, devMode, Header) {
    const templatePath = rocConfig.runtime.template.path || `${myPath}/views`;
    nunjucks.configure(getAbsolutePath(templatePath), {
        watch: devMode,
    });

    const bundleName = script[0];
    const styleName = css[0];

    return (
        head,
        content = '',
        fluxState = {},
        redialProps = [],
        customTemplateValues = {}
    ) => {
        const { dev, build, ...rest } = rocConfig; // eslint-disable-line

        const rocConfigClient = distMode ? rest : { ...rest, dev };

        // If we have no head we will generate it
        if (!head) {
            // Render to trigger React Helmet
            renderToStaticMarkup(<Header />);
            head = Helmet.rewind(); // eslint-disable-line
        }

        return nunjucks.render(rocConfig.runtime.template.name, {
            head,
            content,
            fluxState: serialize(fluxState),
            bundleName,
            styleName,
            dist: distMode,
            serializedRocConfig: serialize(rocConfigClient),
            serializedAppConfig: serialize(appConfig),
            redialProps: serialize(redialProps),
            custom: customTemplateValues,
        });
    };
}

export function reactRender({
    url,
    history,
    store,
    createRoutes,
    renderPage,
    koaState,
    staticRender = false,
    hasTemplateValues,
    templateValues,
    reduxSagas,
}) {
    return new Promise((resolve) => {
        let currentLocation;

        history.listen((location) => {
            currentLocation = location;
        });

        match({ history, routes: createRoutes(store), location: url },
            (error, redirect, renderProps) => {
                if (redirect) {
                    const base = redirect.basename || '';
                    const redirectUrl = `${base}${redirect.pathname}${redirect.search}`;
                    log(`Redirect request to ${redirectUrl} due to React Router`);

                    return resolve({
                        redirect: redirectUrl,
                    });
                } else if (error) {
                    log('Router error', pretty.render(error));
                    return resolve({
                        status: 500,
                        body: renderPage(),
                    });
                } else if (!renderProps) {
                    log('No renderProps, most likely the path does not exist');
                    return resolve({
                        status: 404,
                        body: renderPage(),
                    });
                }

                const locals = store ? {
                    dispatch: store.dispatch,
                    getState: store.getState,
                    history,
                } : {
                    history,
                };

                const hooks = rocConfig.runtime.fetch.server;

                let sagaPromise;
                if (reduxSagas) {
                    sagaPromise = store.runSaga(reduxSagas).done;
                }

                return triggerHooks({
                    renderProps,
                    hooks,
                    locals,
                }).then((result) => {
                    if (sagaPromise) {
                        store.dispatch(require('redux-saga').END); // eslint-disable-line
                        return sagaPromise.then(() => result);
                    }
                    return result;
                }).then(({ redialMap, redialProps }) => {
                    if (currentLocation) {
                        const currentUrl = `${currentLocation.pathname}${currentLocation.search}`;

                        if (currentUrl !== url) {
                            const base = currentLocation.basename || '';
                            const redirectUrl = `${base}${currentUrl}`;

                            log(`Redirect request to ${redirectUrl} due to history location modification`);
                            return resolve({
                                redirect: `${redirectUrl}`,
                            });
                        }
                    }

                    let component = applyRouterMiddleware(useRedial({ redialMap }))(renderProps);

                    if (store) {
                        component = (
                            <Provider store={store}>
                                {component}
                            </Provider>
                        );
                    }

                    const page = staticRender ? renderToStaticMarkup(component) : renderToString(component);
                    const head = Helmet.rewind();
                    const state = store ? store.getState() : {};

                    let computedTemplateValues;
                    if (hasTemplateValues) {
                        // Provides settings, Redux state and Koa state
                        computedTemplateValues = templateValues.default({
                            koaState,
                            settings: rocConfig,
                            reduxState: state,
                        });
                    }

                    return resolve({
                        body: renderPage(head, page, state, redialProps, computedTemplateValues),
                        status: ServerStatus.rewind() || 200,
                    });
                })
                .catch((err) => {
                    if (err) {
                        log('Fetching error', pretty.render(err));
                    }
                    return resolve({
                        status: 500,
                        body: renderPage(),
                    });
                });
            });
    });
}
