'use strict';

angular.module('RAB')
    .controller('SidebarCtrl', ['$rootScope', '$scope', '$routeParams', '$timeout', 'restResources',
        function ($rootScope, $scope, $routeParams, $timeout, restResources) {
            $rootScope.resourcesLoaded = false;
            $scope.publicOnly = true;
            $scope.resources = [];
            $scope.$watch("publicOnly", loadResources);

            function loadResources(newValue) {
                if (newValue !== undefined) {
                    $rootScope.resourcesLoaded = false;
                    $scope.resourceLoadingError = false;
                    restResources(newValue).then(loadComplete, function() {}, loadProgress);
                }
            }

            function loadComplete() {
                $rootScope.resourcesLoaded = true;
            }

            function loadProgress(resources) {
                if (resources && resources.length) {
                    $scope.resources.push.apply($scope.resources, resources);
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