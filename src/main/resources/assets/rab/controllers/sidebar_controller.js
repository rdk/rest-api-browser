'use strict';

angular.module('RAB')
    .controller('SidebarCtrl', ['$rootScope', '$scope', '$routeParams', '$timeout', 'restResources',
        function ($rootScope, $scope, $routeParams, $timeout, restResources) {
            $rootScope.resourcesLoaded = false;
            $scope.publicOnly = true;
            $scope.resources = [];
            var pendingLoads = 0;
            $scope.$watch("publicOnly", loadResources);
            $scope.$watch(function() { return $routeParams.key; }, syncSelectedResource);

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