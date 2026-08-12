-- Keycloak과 포털은 DB를 분리한다. Keycloak 스키마는 제품이 소유하므로 절대 섞지 않는다.
CREATE USER keycloak WITH PASSWORD 'keycloak';
CREATE DATABASE keycloak OWNER keycloak;

CREATE USER portal WITH PASSWORD 'portal';
CREATE DATABASE portal OWNER portal;
