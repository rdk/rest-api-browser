'use strict';

angular.module('RAB', ['ngRoute', 'ngSanitize', 'ui.codemirror','ui.unique'])
    .config(['$routeProvider',
        function ($routeProvider) {
            var resourcePrefix = AJS.contextPath() + '/download/resources/com.atlassian.labs.rest-api-browser:assets/rab';
            $routeProvider
                .when('/', {
                    templateUrl: resourcePrefix + '/views/main.html',
                    controller: 'MainCtrl'
                })
                .when('/search/:query', {
                    templateUrl: resourcePrefix + '/views/main.html',
                    controller: 'MainCtrl'
                })
                .when('/resource/:key', {
                    templateUrl: resourcePrefix + '/views/resource.html',
                    controller: 'ResourceCtrl'
                })
                .when('/resource/:key/:method', {
                    templateUrl: resourcePrefix + '/views/resource.html',
                    controller: 'ResourceCtrl'
                })
                .otherwise({
                    redirectTo: '/'
                });
        }
    ])
    .filter('encodeQuery', function(){
        // used as a workaround to the lack of catch-all routeParam support in angular
        // slashes in search query params are encoded with "::". This filter is applied
        // the filtered results url. The search query param is decoded in the mainCtrl.
        return function(input){
            if (!input) return;
            return input.replace(/\//g,'::');
        }
    })
    .filter('sanitize', function(){
        // sanitizes HTML via caja's html_sanitizer
        return function(input){
            if (!input) return;
            function urlFilter(url){
                if(/^https?:\/\//.test(url)) { return url; }
            }
            return html_sanitize(input, urlFilter);
        }
    })
    .filter('showPublicOnly', function($filter){
        return function(resources, publicOnly){
            if (publicOnly){
                return $filter('filter')(resources, {public:true});
            } else {
                return resources;
            }
        };
    })
    .run(function($rootScope){
        // Draggable divider
        function initDivider(){
            var sbWidth = jQuery('.rab-sidebar').width();
            var mainWidth = jQuery('.rab-main').width() + 40;
            var mainMarginLeft = parseInt(jQuery('.rab-main').css('margin-left'));
            function sizeSearchInput(sbWidth, offset){
                offset = offset || 0;
                jQuery('.rab-search').css({
                    width: sbWidth + offset - 15,
                    maxWidth: sbWidth + offset - 15
                });
            }
            sizeSearchInput(sbWidth);
            jQuery('.rab-divider')
                .css('margin-left',sbWidth + 'px')
                .draggable({
                    axis: 'x',
                    cursor: 'col-resize',
                    drag: function(evt, ui){
                        jQuery('.rab-sidebar').width(sbWidth + ui.offset.left);
                        jQuery('.rab-main').width(mainWidth - ui.offset.left)
                            .css('margin-left',function(){
                                return (mainMarginLeft + ui.offset.left) + "px";
                            });
                        sizeSearchInput(sbWidth, ui.offset.left);
                    }
                });
        }
        initDivider();
        jQuery(window).on('resize', initDivider);
    });