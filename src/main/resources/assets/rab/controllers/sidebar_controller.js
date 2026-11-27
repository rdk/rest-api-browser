'use strict';

angular.module('RAB')
    .controller('SidebarCtrl', ['$rootScope', '$scope', '$routeParams', '$timeout', 'restResources',
        function ($rootScope, $scope, $routeParams, $timeout, restResources) {
            $rootScope.resourcesLoaded = false;
            $scope.publicOnly = true;
            $scope.resources = [];
            $scope.failedModules = [];
            $scope.newUiUrl = ((window.RAB && RAB.baseUrl) || '') + '/plugins/servlet/rest-api-browser';
            var pendingLoads = 0;
            $scope.$watch("publicOnly", function(newValue) {
                syncFailedModules();
                loadResources(newValue);
            });
            $rootScope.$watch("failedWadlServices", syncFailedModules, true);
            $scope.$watch(function() { return $routeParams.key; }, syncSelectedResource);

            function syncFailedModules() {
                var failed = $rootScope.failedWadlServices || [];
                var filtered = [];
                for (var i = 0; i < failed.length; i++) {
                    if (!$scope.publicOnly || failed[i]['public']) {
                        filtered.push(failed[i]);
                    }
                }
                filtered.sort(function(a, b) {
                    return a.relativeResource < b.relativeResource ? -1 : (a.relativeResource > b.relativeResource ? 1 : 0);
                });
                $scope.failedModules = filtered;
            }

            function syncSelectedResource() {
                if (!$routeParams.key || !$scope.resources) return;
                for (var i = 0; i < $scope.resources.length; i++) {
                    if ($scope.resources[i].key === $routeParams.key) {
                        $rootScope.selectedResource = $scope.resources[i];
                        return;
                    }
                }
            }

            function loadResources(newValue) {
                if (newValue !== undefined) {
                    pendingLoads++;
                    $rootScope.resourcesLoaded = false;
                    $scope.resourceLoadingError = false;
                    restResources(newValue).then(loadComplete, loadComplete, loadProgress);
                }
            }

            function loadComplete() {
                pendingLoads = Math.max(0, pendingLoads - 1);
                if (pendingLoads === 0) {
                    $rootScope.resourcesLoaded = true;
                }
                syncSelectedResource();
            }

            function loadProgress(resources) {
                if (resources && resources.length) {
                    $scope.resources.push.apply($scope.resources, resources);
                    syncSelectedResource();
                }
            }

            $scope.selectCurrent = function() {
                if ($routeParams.key === this.resource.key) {
                    $rootScope.selectedResource = this.resource;
                    return true;
                }
                return false;
            };
        }]
    );