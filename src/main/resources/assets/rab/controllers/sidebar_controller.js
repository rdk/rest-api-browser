'use strict';

angular.module('RAB')
    .controller('SidebarCtrl', ['$rootScope', '$scope', '$routeParams', 'restResources',
        function ($rootScope, $scope, $routeParams, restResources) {
            $rootScope.resourcesLoaded = false;

            // Used to set up selected nav item
            $scope.routeParams = $routeParams;

            // Load resources from WADLs
            var loader = new restResources.ResourcesLoader($scope);
            loader.load().then(function(){
                $rootScope.resourcesLoaded = true;
            });

            // Stream in resources
            $scope.resources = [];
            $scope.$on('resource-loaded', function(evt,r){
                $scope.$apply(function(){
                    $scope.resources = $scope.resources.concat(r.resources);
                });
            });

            $scope.selectCurrent = function(){
                if ($routeParams.key === this.resource.key) {
                    $rootScope.selectedResource = this.resource;
                    return true;
                }
                return false;
            };
        }]
    );