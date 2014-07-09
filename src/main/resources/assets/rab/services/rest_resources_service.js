'use strict';

angular.module('RAB')
    .factory('restResources', ['$rootScope', '$q',
        function ($rootScope, $q) {

            var JIRA_PUBLIC_APIS = [
                '^json-rpc/',
                '^api/2',
                '^auth/',
                '^activities/'
            ];

            var CONFLUENCE_PUBLIC_APIS = [
                '^api/'
            ];

            var STASH_PUBLIC_APIS = [
                '^api/',
                '^audit/',
                '^build\-status/',
                '^jira/1\.0/',
                '^ssh/',
                '^branch-permissions/',
                '^auth/'
            ];

            var BAMBOO_PUBLIC_APIS = [
                '^api/'
            ];

            // filter out crowd resources which require basic auth to use
            var FILTERED_SERVICES = _.reject(RAB.rest.services, function(r){
                return (/usermanagement|appmanagement/.test(r.wadl));
            });

            var PUBLIC_APIS = [];
            if(/JIRA/i.test(RAB.product)) { PUBLIC_APIS = JIRA_PUBLIC_APIS }
            else if(/Confluence/i.test(RAB.product)) { PUBLIC_APIS = CONFLUENCE_PUBLIC_APIS }
            else if(/Stash/i.test(RAB.product)) { PUBLIC_APIS = STASH_PUBLIC_APIS }
            else if(/Bamboo/i.test(RAB.product)) { PUBLIC_APIS = BAMBOO_PUBLIC_APIS }

            var compiledPublicAPIRe = new RegExp("("+PUBLIC_APIS.join("|")+")");
            var resources = [];
            var loadedServices = {};

            function isServiceLoaded(service) {
                return !!loadedServices[service.relativeResource];
            }

            function isServicePublic(serviceName) {
                return PUBLIC_APIS.length > 0 && compiledPublicAPIRe.test(serviceName);
            }

            return function(publicOnly) {
                var dfd = $q.defer();
                var resolvedCount = 0;

                var services = _.filter(FILTERED_SERVICES, function(service) {
                    return !isServiceLoaded(service) && (!publicOnly || (publicOnly && isServicePublic(service.relativeResource)));
                });

                var resolvedWADL = function(r) {
                    var newResources = _.map(r.resources, function(resource) {
                        resource.public = !!isServicePublic(resource.name);
                        return resource;
                    });
                    resources.push.apply(resources, newResources);
                    loadedServices[r.ns.relativeResource] = true;
                    dfd.notify(newResources);
                };

                // Handle the good and bad (bad are effectively skipped)
                var handledWADL = function() {
                    resolvedCount++;
                    if (resolvedCount === services.length) {
                        dfd.resolve(resources);
                    }
                };

                _.each(services, function(service) {
                    processWADL(service).done(resolvedWADL).always(handledWADL);
                });

                return dfd.promise;
            };
        }
    ]);