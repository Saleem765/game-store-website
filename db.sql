create table user_roles (
    role_id int primary key identity(1,1),
    role_name varchar(50) not null
);

create table users (
    user_id int primary key identity(1,1),
    username varchar(50) not null,
    email varchar(100) not null unique,
    password varchar(255) not null,
    role_id int,
    foreign key (role_id) references user_roles(role_id)
);

create table games (
    game_id int primary key identity(1,1),
    title varchar(100) not null,
    description text,
    price decimal(10,2) not null,
    genre varchar(50),
    platform varchar(50)
);

create table order_status (
    status_id int primary key identity(1,1),
    status_name varchar(50) not null 
);

create table orders (
    order_id int primary key identity(1,1),
    user_id int,
    order_date datetime default current_timestamp,
    total_amount decimal(10,2),
    status_id int,
    foreign key (user_id) references users(user_id),
    foreign key (status_id) references order_status(status_id)
);

create table payment_status (
    status_id int primary key identity(1,1),
    status_name varchar(50) not null 
);

create table payment_methods (
    method_id int primary key identity(1,1),
    method_name varchar(50) not null 
);

create table payments (
    payment_id int primary key identity(1,1),
    order_id int,
    payment_date datetime default current_timestamp,
    status_id int,
    method_id int,
    foreign key (order_id) references orders(order_id),
    foreign key (status_id) references payment_status(status_id),
    foreign key (method_id) references payment_methods(method_id)
);

create table inventory (
    game_id int primary key,
    stock_quantity int not null,
    foreign key (game_id) references games(game_id)
);

create table order_items (
    order_item_id int primary key identity(1,1),
    order_id int,
    game_id int,
    quantity int not null,
    price decimal(10,2) not null,
    foreign key (order_id) references orders(order_id),
    foreign key (game_id) references games(game_id)
);

create view user_order_details as
select 
    u.username,
    o.order_id,
    o.order_date,
    g.title,
    oi.quantity,
    oi.price
from users u
join orders o on u.user_id = o.user_id
join order_items oi on o.order_id = oi.order_id
join games g on g.game_id = oi.game_id;

create index idx_orders_user on orders(user_id);
create index idx_order_items_order on order_items(order_id);
create index idx_order_items_game on order_items(game_id);

create trigger trg_update_inventory_after_order
on order_items
after insert
as
begin
    update inventory
    set stock_quantity = stock_quantity - i.quantity
    from inserted i
    where inventory.game_id = i.game_id;
end;

-- User roles
insert into user_roles (role_name) values ('customer'), ('admin');

-- Order status
insert into order_status (status_name) values ('pending'), ('completed'), ('cancelled');

-- Payment status
insert into payment_status (status_name) values ('paid'), ('failed'), ('pending');

-- Payment methods
insert into payment_methods (method_name) values ('credit_card'), ('bank_transfer');











